import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const id = (len = 10) =>
	crypto.randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toLowerCase();

export const elementorId = () => crypto.randomBytes(4).toString('hex').slice(0, 7);

export const nowIso = () => new Date().toISOString();

export const isSafeId = (value) => typeof value === 'string' && /^[a-z0-9]{4,24}$/.test(value);

export function writeJsonAtomic(file, obj) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(obj, null, '\t'));
	fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

export function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// Child CLIs get an allowlisted environment: enough to run and authenticate,
// but no incidental secrets (cloud keys, tokens) that a prompt-injected
// reference file could ask an agent to exfiltrate into a design.
const ENV_ALLOWLIST = [
	'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG',
	'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
];

export function cleanEnv() {
	const env = {};
	for (const key of ENV_ALLOWLIST) {
		if (process.env[key] != null) env[key] = process.env[key];
	}
	for (const key of Object.keys(process.env)) {
		if (key.startsWith('LC_')) env[key] = process.env[key];
	}
	return env;
}

// Pull a complete HTML document out of agent chatter. Prefers fenced blocks,
// falls back to the outermost <!doctype|<html slice.
export function extractHtml(text) {
	if (!text) return null;
	const fences = [...text.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)]
		.map((m) => m[1])
		.filter((block) => /<html|<!doctype/i.test(block));
	if (fences.length) return fences.sort((a, b) => b.length - a.length)[0].trim();
	const start = text.search(/<!doctype html|<html[\s>]/i);
	if (start === -1) return null;
	const end = text.lastIndexOf('</html>');
	return end > start ? text.slice(start, end + '</html>'.length).trim() : null;
}

export function extractJsonObject(text) {
	if (!text) return null;
	const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)```/i);
	const candidates = [fence?.[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), text];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate);
		} catch { /* try next */ }
	}
	return null;
}

// Wrap a fragment so previews always get a full document.
export function ensureDocument(html) {
	if (/<html[\s>]/i.test(html)) return html;
	return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${html}\n</body>\n</html>`;
}

export class Semaphore {
	constructor(limit) {
		this.limit = Math.max(1, limit);
		this.active = 0;
		this.queue = [];
	}

	async run(fn) {
		if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve));
		this.active += 1;
		try {
			return await fn();
		} finally {
			this.active -= 1;
			this.queue.shift()?.();
		}
	}
}

export class SseHub {
	constructor() {
		this.clients = new Set();
		setInterval(() => {
			for (const res of this.clients) res.write(': ping\n\n');
		}, 25000).unref();
	}

	handler = (req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
		});
		res.write('retry: 2000\n\n');
		this.clients.add(res);
		// res 'close' fires on connection teardown; req 'close' can fire at
		// message end on modern Node, which would drop clients immediately.
		res.on('close', () => this.clients.delete(res));
	};

	emit(event) {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of this.clients) res.write(payload);
	}
}

export function copyIfExists(from, to) {
	if (fs.existsSync(from)) {
		fs.copyFileSync(from, to);
		return true;
	}
	return false;
}

export function rmrf(target) {
	fs.rmSync(target, { recursive: true, force: true });
}

export function listDirs(dir) {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
	} catch {
		return [];
	}
}

export const MIME_BY_EXT = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.svg': 'image/svg+xml',
	'.html': 'text/html',
};

export const extOf = (name) => path.extname(String(name || '')).toLowerCase();
