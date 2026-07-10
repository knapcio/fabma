import fs from 'node:fs';
import path from 'node:path';
import { getProvider } from './providers/index.js';
import {
	buildElementorConvertPrompt, buildGeneratePrompt, buildRefinePrompt, pickDirections, REFINE_TAKES,
} from './prompts.js';
import {
	copyIfExists, elementorId, ensureDir, ensureDocument, extractHtml, extractJsonObject, extOf, id,
	MIME_BY_EXT, nowIso, rmrf,
} from './util.js';

const TIMEOUT_MS = Number(process.env.FABMA_TIMEOUT_MS) || 10 * 60 * 1000;
const MAX_INLINE_MARKUP = 300 * 1024;
const MAX_INLINE_IMAGE = 4 * 1024 * 1024;

// deps: { store, sse, semaphore }
export function createEngine(deps) {
	const running = new Map(); // `${genId}:${index}` -> { kill() }
	const converts = new Map(); // taskId -> convert task

	function startGeneration(project, opts) {
		const provider = getProvider(opts.provider || opts.providerId);
		if (!provider) throw httpError(400, `Unknown provider: ${opts.provider || opts.providerId}`);

		const kind = opts.parent ? 'refine' : 'brief';
		const count = Math.min(6, Math.max(1, Number(opts.count) || 4));
		const mode = ['page', 'section', 'illustration'].includes(opts.mode) ? opts.mode : project.mode;
		const parentVariant = opts.parent ? requireParentVariant(project, opts.parent) : null;

		const directions = kind === 'brief' ? pickDirections(count, opts.directionIds) : [];
		const generation = {
			id: id(10),
			createdAt: nowIso(),
			kind,
			mode,
			prompt: String(opts.prompt || '').slice(0, 8000),
			provider: provider.id,
			model: opts.model || null,
			parent: opts.parent || null,
			status: 'running',
			variants: Array.from({ length: count }, (_, index) => ({
				index,
				status: 'pending',
				file: null,
				refs: {},
				direction: directions[index] ? { id: directions[index].id, label: directions[index].label } : null,
				take: kind === 'refine' ? REFINE_TAKES[index % REFINE_TAKES.length] : null,
				provider: provider.id,
				model: opts.model || null,
				comments: [],
			})),
		};
		deps.store.addGeneration(project, generation);
		emitGeneration(project.id, generation);

		for (const variant of generation.variants) {
			runVariant(project.id, generation.id, variant.index).catch((err) =>
				console.error(`[fabma] variant ${generation.id}:${variant.index} crashed:`, err));
		}
		return generation;
	}

	async function runVariant(projectId, generationId, index, overrides = {}) {
		const startedAt = Date.now();
		await deps.semaphore.run(async () => {
			// Every project.json mutation goes through updateProject —
			// concurrent variant jobs would otherwise clobber each other's
			// results with stale snapshots.
			const ctx = deps.store.updateProject(projectId, (project) => {
				const gen = deps.store.findGeneration(project, generationId);
				const variant = gen?.variants[index];
				if (!variant) return null;
				const provider = getProvider(overrides.providerId || variant.provider) || getProvider(gen.provider);
				Object.assign(variant, {
					status: 'running', error: null, provider: provider.id, model: overrides.model ?? variant.model, startedAt: nowIso(),
				});
				gen.status = 'running';
				return { project, gen, variant, provider };
			});
			if (!ctx) return;
			emitVariant(projectId, generationId, ctx.variant);

			const registryKey = `${generationId}:${index}`;
			const jobdir = ensureDir(path.join(deps.store.jobsDir, `${generationId}-v${index}-${id(4)}`));
			let outcome;
			try {
				const { prompt, attachments } = await buildVariantPrompt(ctx.project, ctx.gen, ctx.variant, ctx.provider, jobdir);
				const result = await ctx.provider.generate({
					prompt,
					jobdir,
					model: ctx.variant.model,
					attachments,
					timeoutMs: TIMEOUT_MS,
					onSpawn: (proc) => running.set(registryKey, proc),
				});
				const html = readProduct(jobdir) || extractHtml(result.fallbackText) || extractHtml(result.stdout);
				if (!html) throw new Error(describeFailure(result));

				const fileName = `v${index + 1}.html`;
				deps.store.writeVariantFile(projectId, generationId, fileName, ensureDocument(html));
				rmrf(jobdir);
				outcome = { status: 'done', file: fileName, refs: { markup: fileName }, error: null };
			} catch (err) {
				// Job dir is kept for debugging failed runs.
				outcome = { status: 'error', error: String(err.message || err).slice(0, 2000) };
			} finally {
				running.delete(registryKey);
			}
			outcome.durationMs = Date.now() - startedAt;

			const after = deps.store.updateProject(projectId, (project) => {
				const gen = deps.store.findGeneration(project, generationId);
				const variant = gen?.variants[index];
				if (!variant) return null;
				// A cancel that already landed wins over a late failure.
				if (variant.status === 'error' && variant.error === 'Canceled' && outcome.status !== 'done') return null;
				Object.assign(variant, outcome);
				gen.status = statusOf(gen);
				return { gen, variant };
			});
			if (!after) return;
			emitVariant(projectId, generationId, after.variant);
			emitGeneration(projectId, after.gen);
		});
	}

	async function buildVariantPrompt(project, gen, variant, provider, jobdir) {
		const viaFile = provider.supportsFiles;
		const brief = project.brief + (gen.kind === 'brief' && gen.prompt ? `\nAdditional note: ${gen.prompt}` : '');

		if (gen.kind === 'brief') {
			const direction = variant.direction || pickDirections(1, [])[0];
			return { prompt: buildGeneratePrompt({ brief, mode: gen.mode, direction, viaFile }), attachments: [] };
		}

		const parentGen = deps.store.findGeneration(project, gen.parent.generationId);
		const parentVariant = parentGen?.variants[gen.parent.variant];
		if (!parentVariant) throw new Error('Parent variant no longer exists');
		const genDir = deps.store.generationDir(project.id, parentGen.id);

		const reference = { hasImage: false, imageName: null, hasMarkup: false, inlineHtml: null };
		const attachments = [];
		if (parentVariant.refs?.image) {
			const imagePath = path.join(genDir, parentVariant.refs.image);
			const ext = extOf(parentVariant.refs.image);
			if (viaFile) {
				reference.imageName = `current${ext}`;
				reference.hasImage = copyIfExists(imagePath, path.join(jobdir, reference.imageName));
			} else if (fs.existsSync(imagePath)) {
				const bytes = fs.readFileSync(imagePath);
				if (bytes.length > MAX_INLINE_IMAGE) throw new Error('Screenshot too large for the API provider — use a CLI provider');
				attachments.push({ kind: 'image', mediaType: MIME_BY_EXT[ext] || 'image/png', dataBase64: bytes.toString('base64') });
				reference.hasImage = true;
			}
		}
		if (parentVariant.refs?.markup) {
			const markupPath = path.join(genDir, parentVariant.refs.markup);
			if (viaFile) {
				reference.hasMarkup = copyIfExists(markupPath, path.join(jobdir, 'current.html'));
			} else if (fs.existsSync(markupPath)) {
				reference.inlineHtml = fs.readFileSync(markupPath, 'utf8').slice(0, MAX_INLINE_MARKUP);
				reference.hasMarkup = true;
			}
		}
		if (!reference.hasImage && !reference.hasMarkup) throw new Error('Parent variant has no readable reference files');

		const prompt = buildRefinePrompt({
			brief: project.brief,
			mode: gen.mode,
			feedback: gen.prompt,
			comments: parentVariant.comments,
			take: variant.take || REFINE_TAKES[0],
			reference,
			viaFile,
		});
		return { prompt, attachments };
	}

	function retryVariant(project, generationId, index, overrides) {
		const gen = deps.store.findGeneration(project, generationId);
		const variant = gen?.variants[index];
		if (!variant) throw httpError(404, 'Variant not found');
		if (variant.status === 'running' || variant.status === 'pending') throw httpError(409, 'Variant is already running');
		if (gen.kind === 'import') throw httpError(400, 'Imported designs cannot be regenerated');
		variant.status = 'pending';
		gen.status = 'running';
		deps.store.saveProject(project);
		emitVariant(project.id, generationId, variant);
		runVariant(project.id, generationId, index, overrides || {}).catch((err) =>
			console.error(`[fabma] retry ${generationId}:${index} crashed:`, err));
	}

	function cancelGeneration(project, generationId) {
		const gen = deps.store.findGeneration(project, generationId);
		if (!gen) throw httpError(404, 'Generation not found');
		for (const variant of gen.variants) {
			const key = `${generationId}:${variant.index}`;
			running.get(key)?.kill?.('SIGTERM');
			running.delete(key);
			if (variant.status === 'running' || variant.status === 'pending') {
				variant.status = 'error';
				variant.error = 'Canceled';
			}
		}
		gen.status = statusOf(gen);
		deps.store.saveProject(project);
		emitGeneration(project.id, gen);
	}

	function startConvert(project, generationId, index, { providerId, model, structure }) {
		const provider = getProvider(providerId);
		if (!provider) throw httpError(400, `Unknown provider: ${providerId}`);
		const gen = deps.store.findGeneration(project, generationId);
		const variant = gen?.variants[index];
		if (!variant?.file) throw httpError(404, 'Variant has no rendered file');

		const task = {
			id: id(10),
			projectId: project.id,
			generationId,
			variantIndex: index,
			structure: structure === 'section' ? 'section' : 'container',
			status: 'running',
			createdAt: nowIso(),
		};
		converts.set(task.id, task);
		emitConvert(task);

		deps.semaphore.run(async () => {
			const jobdir = ensureDir(path.join(deps.store.jobsDir, `convert-${task.id}`));
			try {
				const sourcePath = deps.store.variantFile(project.id, generationId, variant.file);
				const inlineHtml = fs.readFileSync(sourcePath, 'utf8');
				if (provider.supportsFiles) fs.copyFileSync(sourcePath, path.join(jobdir, 'current.html'));
				const prompt = buildElementorConvertPrompt({
					structure: task.structure,
					viaFile: provider.supportsFiles,
					inlineHtml: provider.supportsFiles ? null : inlineHtml,
				});
				const result = await provider.generate({
					prompt, jobdir, model, timeoutMs: TIMEOUT_MS, attachments: [], onSpawn: () => {},
				});
				const raw = readFileIfExists(path.join(jobdir, 'template.json'));
				const template = raw ? JSON.parse(raw) : extractJsonObject(result.fallbackText || result.stdout);
				if (!template) throw new Error(describeFailure(result));
				validateAndRepairTemplate(template);
				const fileName = `v${index + 1}.native-${task.structure}.json`;
				deps.store.writeVariantFile(project.id, generationId, fileName, JSON.stringify(template, null, '\t'));
				Object.assign(task, { status: 'done', file: fileName });
				rmrf(jobdir);
			} catch (err) {
				Object.assign(task, { status: 'error', error: String(err.message || err).slice(0, 1000) });
			}
			emitConvert(task);
		});
		return task;
	}

	function requireParentVariant(project, parent) {
		const gen = deps.store.findGeneration(project, parent.generationId);
		const variant = gen?.variants[parent.variant];
		if (!variant || variant.status !== 'done') throw httpError(400, 'Parent variant is not a finished design');
		return variant;
	}

	function emitVariant(projectId, generationId, variant) {
		deps.sse.emit({ type: 'variant', projectId, generationId, index: variant.index, status: variant.status });
	}

	function emitGeneration(projectId, gen) {
		deps.sse.emit({ type: 'generation', projectId, generationId: gen.id, status: gen.status });
	}

	function emitConvert(task) {
		deps.sse.emit({ type: 'convert', taskId: task.id, projectId: task.projectId, status: task.status });
	}

	return { startGeneration, retryVariant, cancelGeneration, startConvert, getConvert: (tid) => converts.get(tid) };
}

function readProduct(jobdir) {
	const raw = readFileIfExists(path.join(jobdir, 'variant.html'));
	return raw && /<\w+[\s>]/.test(raw) ? raw : null;
}

function readFileIfExists(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

function describeFailure(result) {
	if (result.timedOut) return 'The agent timed out before producing a design';
	const stderrTail = (result.stderr || '').trim().split('\n').slice(-4).join('\n');
	return `The agent finished (exit ${result.exitCode}) without producing a design${stderrTail ? ` — ${stderrTail.slice(0, 500)}` : ''}`;
}

function statusOf(gen) {
	const states = gen.variants.map((v) => v.status);
	if (states.some((s) => s === 'running' || s === 'pending')) return 'running';
	if (states.every((s) => s === 'done')) return 'done';
	return states.some((s) => s === 'done') ? 'partial' : 'failed';
}

// Structural validation + id de-duplication for AI-produced templates.
function validateAndRepairTemplate(template) {
	if (!Array.isArray(template.content)) throw new Error('Template has no content array');
	template.version ||= '0.4';
	template.type ||= 'page';
	template.page_settings ||= [];
	const seen = new Set();
	const walk = (node) => {
		if (!node || typeof node !== 'object') throw new Error('Template contains a non-object element');
		if (typeof node.elType !== 'string') throw new Error('Template element is missing elType');
		if (node.elType === 'widget' && typeof node.widgetType !== 'string') throw new Error('Widget is missing widgetType');
		if (typeof node.id !== 'string' || seen.has(node.id)) node.id = elementorId();
		seen.add(node.id);
		node.settings = node.settings && typeof node.settings === 'object' ? node.settings : {};
		node.elements = Array.isArray(node.elements) ? node.elements : [];
		node.elements.forEach(walk);
	};
	template.content.forEach(walk);
}

function httpError(status, message) {
	const err = new Error(message);
	err.status = status;
	return err;
}

export { httpError };
