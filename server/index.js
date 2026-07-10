import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createStore } from './store.js';
import { createEngine, httpError } from './generate.js';
import { detectProviders } from './providers/index.js';
import { DIRECTIONS } from './prompts.js';
import { exportBlob, exportTemplate } from './exporters/elementor.js';
import { extractSvg } from './exporters/svg.js';
import { ensureDocument, extOf, id, isSafeId, nowIso, Semaphore, SseHub } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_KINDS = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.svg': 'svg', '.html': 'html', '.htm': 'html' };

// Generated designs render inside sandboxed iframes AND under a CSP that
// blocks every network destination except Google Fonts — a hostile variant
// cannot call this local API or exfiltrate anything.
const PREVIEW_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline' https://fonts.googleapis.com",
	'font-src https://fonts.gstatic.com data:',
	'img-src data: blob:',
	"script-src 'unsafe-inline'",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join('; ');

export function start({ workspace, port = Number(process.env.FABMA_PORT) || 4011, open = true } = {}) {
	const store = createStore(workspace);
	store.recoverInterrupted();
	const sse = new SseHub();
	const semaphore = new Semaphore(Number(process.env.FABMA_MAX_CONCURRENCY) || 4);
	const engine = createEngine({ store, sse, semaphore });

	const app = express();
	app.use(express.json({ limit: '16mb' }));

	app.param('pid', (req, res, next, pid) => {
		if (!isSafeId(pid)) return next(httpError(400, 'Bad project id'));
		req.project = store.getProject(pid);
		if (!req.project) return next(httpError(404, 'Project not found'));
		next();
	});
	app.param('gid', (req, res, next, gid) => {
		if (!isSafeId(gid)) return next(httpError(400, 'Bad generation id'));
		req.generation = store.findGeneration(req.project, gid);
		if (!req.generation) return next(httpError(404, 'Generation not found'));
		next();
	});
	app.param('idx', (req, res, next, idx) => {
		req.variant = req.generation?.variants[Number(idx)];
		if (!req.variant) return next(httpError(404, 'Variant not found'));
		next();
	});

	app.get('/api/health', (req, res) => res.json({ ok: true, workspace: store.root, version: '0.1.0' }));
	app.get('/api/providers', async (req, res) => res.json(await detectProviders()));
	app.get('/api/directions', (req, res) => res.json(DIRECTIONS.map(({ id: did, label, hint }) => ({ id: did, label, hint }))));
	app.get('/api/events', sse.handler);

	// Waiters for agents long-polling a human decision.
	const decisionWaiters = new Map(); // generationId -> Set<() => void>

	app.get('/api/projects', (req, res) => res.json(store.listProjects()));
	app.post('/api/projects', (req, res) => res.status(201).json(store.createProject(req.body || {})));

	// Agent entry point: push ready-made HTML variants, get a gallery URL for
	// the human, then poll /feedback (or ?wait=) for their decision.
	app.post('/api/drop', (req, res, next) => {
		const { title, note, variants = [] } = req.body || {};
		if (!variants.length || variants.length > 8) return next(httpError(400, 'Drop expects 1–8 variants: [{ name?, html }]'));
		const project = store.createProject({
			name: title || `Agent session ${new Date().toLocaleString()}`,
			brief: note || title || 'Variants dropped by an agent',
			ephemeral: true,
		});
		const generation = {
			id: id(10),
			createdAt: nowIso(),
			kind: 'drop',
			mode: project.mode,
			prompt: String(note || '').slice(0, 4000),
			provider: null,
			model: null,
			parent: null,
			status: 'done',
			variants: variants.map((v, index) => ({
				index,
				status: 'done',
				file: `v${index + 1}.html`,
				refs: { markup: `v${index + 1}.html` },
				direction: { id: 'drop', label: String(v.name || `Option ${index + 1}`).slice(0, 80) },
				provider: null,
				model: null,
				comments: [],
			})),
		};
		store.addGeneration(project, generation);
		variants.forEach((v, index) => {
			store.writeVariantFile(project.id, generation.id, `v${index + 1}.html`, ensureDocument(String(v.html || '')));
		});
		store.saveProject(project);
		sse.emit({ type: 'generation', projectId: project.id, generationId: generation.id, status: 'done' });
		const base = `${req.protocol}://${req.get('host')}`;
		res.status(201).json({
			projectId: project.id,
			generationId: generation.id,
			url: `${base}/#/p/${project.id}`,
			feedbackUrl: `${base}/api/projects/${project.id}/generations/${generation.id}/feedback`,
			hint: 'Open `url` for the human. GET feedbackUrl?wait=55 long-polls until they decide.',
		});
	});
	app.get('/api/projects/:pid', (req, res) => res.json(withPaths(store, req.project)));
	app.delete('/api/projects/:pid', (req, res) => {
		store.deleteProject(req.project.id);
		res.json({ ok: true });
	});

	app.post('/api/projects/:pid/generations', (req, res) => {
		const generation = engine.startGeneration(req.project, req.body || {});
		res.status(202).json(generation);
	});
	app.delete('/api/projects/:pid/generations/:gid', (req, res, next) => {
		const hasChildren = req.project.generations.some((g) => g.parent?.generationId === req.generation.id);
		if (hasChildren) return next(httpError(409, 'This generation has refinements — delete those first'));
		store.deleteGeneration(req.project, req.generation.id);
		res.json({ ok: true });
	});
	app.post('/api/projects/:pid/generations/:gid/cancel', (req, res) => {
		engine.cancelGeneration(req.project, req.generation.id);
		res.json({ ok: true });
	});

	// The human's verdict on a generation — what agents wait for.
	app.post('/api/projects/:pid/generations/:gid/decide', (req, res, next) => {
		const variant = Number(req.body?.variant);
		if (!req.generation.variants[variant]) return next(httpError(400, 'decide requires a valid variant index'));
		req.generation.decision = {
			variant,
			note: String(req.body?.note || '').slice(0, 4000),
			decidedAt: nowIso(),
		};
		store.saveProject(req.project);
		sse.emit({ type: 'decision', projectId: req.project.id, generationId: req.generation.id });
		for (const wake of decisionWaiters.get(req.generation.id) || []) wake();
		decisionWaiters.delete(req.generation.id);
		res.json(req.generation.decision);
	});

	app.get('/api/projects/:pid/generations/:gid/feedback', async (req, res) => {
		const waitSeconds = Math.min(60, Number(req.query.wait) || 0);
		if (waitSeconds > 0 && !req.generation.decision) {
			await new Promise((resolve) => {
				const set = decisionWaiters.get(req.generation.id) || new Set();
				decisionWaiters.set(req.generation.id, set);
				const timer = setTimeout(done, waitSeconds * 1000);
				function done() {
					clearTimeout(timer);
					set.delete(done);
					resolve();
				}
				set.add(done);
				req.on('close', done);
			});
		}
		const fresh = store.findGeneration(store.getProject(req.project.id), req.generation.id) || req.generation;
		res.json({
			status: fresh.decision ? 'decided' : 'pending',
			decision: fresh.decision || null,
			variants: fresh.variants.map((v) => ({
				index: v.index,
				name: v.direction?.label || `v${v.index + 1}`,
				status: v.status,
				favorite: !!v.favorite,
				comments: v.comments.map(({ text, x, y, createdAt }) => ({ text, x, y, createdAt })),
			})),
		});
	});

	app.post('/api/projects/:pid/import', (req, res, next) => {
		const { files = [], note } = req.body || {};
		if (!files.length || files.length > 2) return next(httpError(400, 'Import expects 1–2 files (screenshot and/or markup)'));
		const generation = {
			id: id(10),
			createdAt: nowIso(),
			kind: 'import',
			mode: req.project.mode,
			prompt: String(note || '').slice(0, 2000),
			provider: null,
			model: null,
			parent: null,
			status: 'done',
			variants: [{ index: 0, status: 'done', file: null, refs: {}, direction: { id: 'import', label: 'Imported' }, provider: null, model: null, comments: [] }],
		};
		const variant = generation.variants[0];
		store.addGeneration(req.project, generation);

		let imageTag = null;
		let markupHtml = null;
		for (const file of files) {
			const ext = extOf(file.name);
			const kind = IMPORT_KINDS[ext];
			if (!kind) return next(httpError(400, `Unsupported import type: ${ext || file.name}`));
			const buffer = Buffer.from(String(file.dataBase64 || ''), 'base64');
			if (!buffer.length) return next(httpError(400, `Empty file: ${file.name}`));
			if (kind === 'image') {
				variant.refs.image = `import${ext}`;
				store.writeVariantFile(req.project.id, generation.id, variant.refs.image, buffer);
				const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
				imageTag = `<img alt="Imported screenshot" src="data:${mime};base64,${buffer.toString('base64')}">`;
			} else if (kind === 'svg') {
				store.writeVariantFile(req.project.id, generation.id, `import${ext}`, buffer);
				markupHtml = wrapImport(buffer.toString('utf8'));
			} else {
				variant.refs.markup = 'import.html';
				store.writeVariantFile(req.project.id, generation.id, 'import.html', buffer);
				markupHtml = buffer.toString('utf8');
			}
		}
		variant.file = 'v1.html';
		const preview = markupHtml || wrapImport(imageTag);
		store.writeVariantFile(req.project.id, generation.id, 'v1.html', preview);
		if (!variant.refs.markup && !variant.refs.image) variant.refs.markup = 'v1.html';
		store.saveProject(req.project);
		sse.emit({ type: 'generation', projectId: req.project.id, generationId: generation.id, status: 'done' });
		res.status(201).json(generation);
	});

	app.get('/api/projects/:pid/generations/:gid/variants/:idx/html', (req, res, next) => {
		if (!req.variant.file) return next(httpError(404, 'Variant has no rendered file'));
		res.set({
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': PREVIEW_CSP,
			'X-Content-Type-Options': 'nosniff',
		});
		res.send(fs.readFileSync(store.variantFile(req.project.id, req.generation.id, req.variant.file), 'utf8'));
	});

	app.get('/api/projects/:pid/generations/:gid/variants/:idx/file', (req, res, next) => {
		if (!req.variant.file) return next(httpError(404, 'Variant has no rendered file'));
		res.set('Content-Disposition', `attachment; filename="${exportName(req)}.html"`);
		res.type('html').send(fs.readFileSync(store.variantFile(req.project.id, req.generation.id, req.variant.file), 'utf8'));
	});

	app.get('/api/projects/:pid/generations/:gid/variants/:idx/svg', (req, res, next) => {
		const html = fs.readFileSync(store.variantFile(req.project.id, req.generation.id, req.variant.file), 'utf8');
		const svg = extractSvg(html);
		if (!svg) return next(httpError(404, 'This variant contains no SVG — SVG export is for illustration variants'));
		res.set('Content-Disposition', `attachment; filename="${exportName(req)}.svg"`);
		res.type('image/svg+xml').send(svg);
	});

	app.get('/api/projects/:pid/generations/:gid/variants/:idx/elementor', (req, res) => {
		const html = fs.readFileSync(store.variantFile(req.project.id, req.generation.id, req.variant.file), 'utf8');
		const template = exportTemplate(html, {
			title: `${req.project.name} — v${req.variant.index + 1}`,
			structure: req.query.structure === 'section' ? 'section' : 'container',
			sliced: req.query.sliced === '1',
		});
		res.set('Content-Disposition', `attachment; filename="${exportName(req)}.elementor.json"`);
		res.json(template);
	});

	app.get('/api/projects/:pid/generations/:gid/variants/:idx/elementor-blob', (req, res) => {
		const html = fs.readFileSync(store.variantFile(req.project.id, req.generation.id, req.variant.file), 'utf8');
		res.type('text/plain').send(exportBlob(html));
	});

	app.post('/api/projects/:pid/generations/:gid/variants/:idx/comments', (req, res, next) => {
		const text = String(req.body?.text || '').trim().slice(0, 2000);
		if (!text) return next(httpError(400, 'Comment text is required'));
		const comment = { id: id(8), text, createdAt: nowIso() };
		if (req.body.x != null && req.body.y != null) {
			comment.x = Math.min(100, Math.max(0, Number(req.body.x)));
			comment.y = Math.min(100, Math.max(0, Number(req.body.y)));
		}
		req.variant.comments.push(comment);
		store.saveProject(req.project);
		res.status(201).json(comment);
	});
	app.delete('/api/projects/:pid/generations/:gid/variants/:idx/comments/:cid', (req, res) => {
		req.variant.comments = req.variant.comments.filter((c) => c.id !== req.params.cid);
		store.saveProject(req.project);
		res.json({ ok: true });
	});

	app.post('/api/projects/:pid/generations/:gid/variants/:idx/favorite', (req, res) => {
		req.variant.favorite = !!req.body?.value;
		store.saveProject(req.project);
		res.json({ ok: true });
	});

	app.post('/api/projects/:pid/generations/:gid/variants/:idx/retry', (req, res) => {
		engine.retryVariant(req.project, req.generation.id, req.variant.index, {
			providerId: req.body?.provider,
			model: req.body?.model,
		});
		res.status(202).json({ ok: true });
	});

	app.post('/api/projects/:pid/generations/:gid/variants/:idx/convert', (req, res) => {
		const task = engine.startConvert(req.project, req.generation.id, req.variant.index, {
			providerId: req.body?.provider,
			model: req.body?.model,
			structure: req.body?.structure,
		});
		res.status(202).json(task);
	});
	app.get('/api/converts/:tid', (req, res, next) => {
		const task = engine.getConvert(req.params.tid);
		if (!task) return next(httpError(404, 'Convert task not found'));
		res.json(task);
	});
	app.get('/api/converts/:tid/file', (req, res, next) => {
		const task = engine.getConvert(req.params.tid);
		if (task?.status !== 'done') return next(httpError(404, 'Converted template not ready'));
		res.set('Content-Disposition', `attachment; filename="native-${task.structure}.elementor.json"`);
		res.type('json').send(fs.readFileSync(path.join(store.generationDir(task.projectId, task.generationId), task.file), 'utf8'));
	});

	app.get('/agent.md', (req, res) => {
		res.type('text/markdown').send(fs.readFileSync(path.join(__dirname, '..', 'AGENT.md'), 'utf8'));
	});
	app.use(express.static(path.join(__dirname, '..', 'web')));
	app.use('/examples', express.static(path.join(__dirname, '..', 'examples')));

	app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
	// eslint-disable-next-line no-unused-vars
	app.use((err, req, res, next) => {
		const status = err.status || 500;
		if (status >= 500) console.error('[fabma]', err);
		res.status(status).json({ error: err.message || 'Internal error' });
	});

	const server = app.listen(port, '127.0.0.1', () => {
		const url = `http://localhost:${port}`;
		console.log(`\n  ✳ fabma — the AI-native design playground`);
		console.log(`    ${url}`);
		console.log(`    workspace: ${store.root}\n`);
		if (open && process.env.FABMA_NO_OPEN !== '1') openBrowser(url);
	});
	return server;
}

function wrapImport(inner) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
	html, body { margin: 0; min-height: 100%; background: #f2f0ed; }
	body { display: grid; place-items: start center; }
	img, svg { max-width: 100%; height: auto; display: block; }
</style>
</head>
<body>
${inner || ''}
</body>
</html>`;
}

function withPaths(store, project) {
	return {
		...project,
		generations: project.generations.map((gen) => ({
			...gen,
			variants: gen.variants.map((variant) => ({
				...variant,
				path: variant.file ? store.variantFile(project.id, gen.id, variant.file) : null,
				refPaths: Object.fromEntries(Object.entries(variant.refs || {}).map(
					([key, file]) => [key, store.variantFile(project.id, gen.id, file)],
				)),
			})),
		})),
	};
}

function exportName(req) {
	const slug = req.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
	return `${slug}-v${req.variant.index + 1}`;
}

function openBrowser(url) {
	const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	try {
		spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
	} catch { /* printing the URL is enough */ }
}
