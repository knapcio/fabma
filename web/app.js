/* fabma frontend — no build step, no framework. */

// The mark: four variants, one picked.
const SPARK = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="2.5" width="8.6" height="8.6" rx="2.6" fill="#C9C4BC"/><rect x="12.9" y="2.5" width="8.6" height="8.6" rx="2.6" fill="#C9C4BC"/><rect x="2.5" y="12.9" width="8.6" height="8.6" rx="2.6" fill="#C9C4BC"/><rect x="12.9" y="12.9" width="8.6" height="8.6" rx="2.6" fill="#E8431A"/></svg>`;
const VIEWPORTS = { desktop: { w: 1440, h: 900 }, mobile: { w: 390, h: 844 } };

const state = {
	providers: [],
	directions: [],
	projects: [],
	project: null,
	activeGenId: null,
	selection: null, // { genId, index }
	viewport: 'desktop',
	settings: load('fabma.settings', { provider: null, model: '', count: 4, refineCount: 3 }),
	chipIds: [],
};

/* ---------- tiny helpers ---------- */

const $app = document.getElementById('app');

function el(tag, props = {}, ...kids) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'class') node.className = value;
		else if (key === 'html') node.innerHTML = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (key === 'style') node.style.cssText = value;
		else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
	}
	for (const kid of kids.flat()) {
		if (kid == null || kid === false) continue;
		node.append(kid.nodeType ? kid : document.createTextNode(kid));
	}
	return node;
}

async function api(method, url, body) {
	const response = await fetch(url, {
		method,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.error || `${response.status} ${response.statusText}`);
	}
	return response.json();
}

function toast(message, kind = '', html = false) {
	const node = el('div', { class: `toast ${kind}` });
	if (html) node.innerHTML = message;
	else node.textContent = message;
	document.getElementById('toasts').append(node);
	setTimeout(() => node.remove(), kind === 'err' ? 9000 : 6000);
}

const fail = (err) => toast(err.message || String(err), 'err');

async function copyText(text, label = 'Copied') {
	await navigator.clipboard.writeText(text);
	toast(label, 'ok');
}

function load(key, fallback) {
	try {
		return { ...fallback, ...JSON.parse(localStorage.getItem(key)) };
	} catch {
		return fallback;
	}
}

const persistSettings = () => localStorage.setItem('fabma.settings', JSON.stringify(state.settings));

const timeAgo = (iso) => {
	const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
};

const fmtDur = (ms) => (ms ? (ms > 90000 ? `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`) : '');

/* ---------- data loading ---------- */

async function boot() {
	[state.providers, state.directions, state.projects] = await Promise.all([
		api('GET', '/api/providers'),
		api('GET', '/api/directions'),
		api('GET', '/api/projects'),
	]);
	if (!state.settings.provider || !state.providers.find((p) => p.id === state.settings.provider && p.available)) {
		state.settings.provider = state.providers.find((p) => p.available)?.id || null;
	}
	connectSse();
	window.addEventListener('hashchange', route);
	await route();
	setInterval(tickElapsed, 1000);
}

async function route() {
	const match = location.hash.match(/^#\/p\/([a-z0-9]+)/);
	if (match) {
		await openProject(match[1]);
	} else {
		state.project = null;
		state.selection = null;
		render();
	}
}

async function openProject(pid, keepSelection = false) {
	try {
		const fresh = await api('GET', `/api/projects/${pid}`);
		const isSame = state.project?.id === fresh.id;
		state.project = fresh;
		if (!isSame) {
			state.activeGenId = fresh.generations.at(-1)?.id || null;
			state.selection = null;
		} else {
			if (!fresh.generations.find((g) => g.id === state.activeGenId)) {
				state.activeGenId = fresh.generations.at(-1)?.id || null;
			}
			if (!keepSelection) {
				const sel = state.selection;
				if (sel && !fresh.generations.find((g) => g.id === sel.genId)?.variants[sel.index]) state.selection = null;
			}
		}
		render();
	} catch (err) {
		fail(err);
		location.hash = '#/';
	}
}

let refreshTimer = null;
function scheduleRefresh() {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(async () => {
		state.projects = await api('GET', '/api/projects').catch(() => state.projects);
		if (state.project) await openProject(state.project.id, true).catch(() => {});
		else render();
	}, 250);
}

const pendingConverts = new Set();
const IS_DESKTOP = navigator.userAgent.includes('Electron');

function connectSse() {
	const source = new EventSource('/api/events');
	source.onmessage = async (event) => {
		const data = JSON.parse(event.data);
		// In the desktop app, a fresh agent drop takes the stage by itself —
		// the human should just see the options appear.
		if (IS_DESKTOP && data.type === 'generation' && data.projectId !== state.project?.id
			&& !state.projects.some((p) => p.id === data.projectId)) {
			state.projects = await api('GET', '/api/projects').catch(() => state.projects);
			if (state.projects.some((p) => p.id === data.projectId && p.ephemeral)) {
				location.hash = `#/p/${data.projectId}`;
				return;
			}
		}
		if (data.type === 'convert') {
			if (!pendingConverts.has(data.taskId)) return; // another tab's convert
			if (data.status === 'done') {
				pendingConverts.delete(data.taskId);
				toast(`Native Elementor template ready — <a href="/api/converts/${data.taskId}/file">download</a>`, 'ok', true);
				window.location.assign(`/api/converts/${data.taskId}/file`);
			} else if (data.status === 'error') {
				pendingConverts.delete(data.taskId);
				api('GET', `/api/converts/${data.taskId}`).then((t) => toast(`Convert failed: ${t.error}`, 'err')).catch(() => {});
			}
			return;
		}
		scheduleRefresh();
	};
}

/* ---------- rendering ---------- */

function render() {
	closeMenus();
	$app.replaceChildren(renderRail(), renderMain());
}

function renderRail() {
	const rail = el('aside', { class: 'rail' });
	rail.append(el('div', { class: 'brand', onclick: () => { location.hash = '#/'; } },
		el('span', { html: SPARK, style: 'display:flex' }),
		el('span', { class: 'word' }, 'fabma'),
		el('span', { class: 'sub' }, 'playground')));

	if (state.project) {
		const project = state.project;
		rail.append(el('div', { class: 'rail-back', onclick: () => { location.hash = '#/'; } }, '←', ' All projects'));
		rail.append(el('div', { class: 'rail-project-name' }, project.name,
			project.ephemeral ? el('span', { class: 'badge ember', style: 'margin-left:8px' }, 'agent') : null));
		rail.append(el('div', { class: 'rail-project-brief', title: project.brief }, project.brief));

		const list = el('div', { class: 'rail-section' }, el('div', { class: 'rail-label' }, 'Generations'));
		const depth = genDepths(project);
		for (const gen of project.generations) {
			const isActive = gen.id === state.activeGenId;
			const doneCount = gen.variants.filter((v) => v.status === 'done').length;
			const label = gen.kind === 'import' ? 'Imported'
				: gen.kind === 'drop' ? `Agent drop · ${gen.variants.length} options`
					: gen.kind === 'refine' ? `Refine of ${parentLabel(project, gen)}`
						: 'From the brief';
			const node = el('div', { class: 'gen-node', style: `--depth:${depth.get(gen.id) || 0}` },
				el('div', {
					class: `rail-item ${isActive ? 'active' : ''}`,
					onclick: () => { state.activeGenId = gen.id; state.selection = null; render(); },
				},
				el('div', { class: 'name' },
					el('span', { class: `gen-status ${gen.status}` }, gen.status === 'running' ? '◐' : gen.status === 'done' ? '●' : gen.status === 'partial' ? '◑' : gen.kind === 'import' || gen.kind === 'drop' ? '●' : '○'),
					label,
					gen.decision ? el('span', { class: 'badge ember' }, `picked v${gen.decision.variant + 1}`) : null),
				el('div', { class: 'meta' }, [gen.prompt?.slice(0, 60), `${doneCount}/${gen.variants.length}`, timeAgo(gen.createdAt)].filter(Boolean).join(' · '))));
			list.append(node);
		}
		rail.append(list);
		rail.append(el('div', { class: 'rail-footer' },
			el('button', { class: 'btn small grow', onclick: () => importModal() }, '⇪ Import'),
			el('button', { class: 'btn small grow', onclick: () => deleteProjectAction() }, '✕ Delete')));
	} else {
		const list = el('div', { class: 'rail-section' }, el('div', { class: 'rail-label' }, 'Projects'));
		if (!state.projects.length) list.append(el('div', { class: 'rail-item' }, el('div', { class: 'meta' }, 'Nothing yet — create one below.')));
		for (const project of state.projects) {
			list.append(el('div', { class: 'rail-item', onclick: () => { location.hash = `#/p/${project.id}`; } },
				el('div', { class: 'name' }, project.name, project.ephemeral ? el('span', { class: 'badge ember' }, 'agent') : null),
				el('div', { class: 'meta' }, `${project.generationCount} generations · ${timeAgo(project.lastActivity)}`)));
		}
		rail.append(list);
		rail.append(el('div', { class: 'rail-footer' },
			el('button', { class: 'btn primary small grow', onclick: newProjectModal }, '✳ New project')));
	}
	return rail;
}

function parentLabel(project, gen) {
	const parent = project.generations.find((g) => g.id === gen.parent?.generationId);
	if (!parent) return 'a deleted generation';
	return `v${gen.parent.variant + 1}`;
}

function genDepths(project) {
	const depth = new Map();
	for (const gen of project.generations) {
		let d = 0;
		let cursor = gen;
		while (cursor?.parent) {
			d += 1;
			cursor = project.generations.find((g) => g.id === cursor.parent.generationId);
			if (d > 6) break;
		}
		depth.set(gen.id, Math.min(d, 6));
	}
	return depth;
}

function renderMain() {
	const main = el('main', { class: 'main' });
	if (!state.project) {
		main.append(renderWelcome());
		return main;
	}
	const project = state.project;
	const gen = project.generations.find((g) => g.id === state.activeGenId);

	main.append(el('div', { class: 'topbar' },
		el('h1', {}, project.name),
		el('span', { class: 'badge' }, project.mode),
		el('div', { class: 'spacer' }),
		renderViewportToggle(),
		el('button', { class: 'btn small', onclick: () => importModal() }, '⇪ Import')));

	const content = el('div', { class: 'content' });
	if (!gen) {
		content.append(el('div', { class: 'welcome' },
			el('h1', {}, 'A blank canvas.'),
			el('p', {}, 'Generate the first round of art directions from your brief with the dock below, or import an existing design / screenshot.')));
	} else {
		content.append(renderGeneration(project, gen));
	}
	main.append(content);
	main.append(renderDock(project, gen));
	return main;
}

function renderViewportToggle() {
	const seg = el('div', { class: 'seg' });
	for (const key of ['desktop', 'mobile']) {
		seg.append(el('button', {
			class: state.viewport === key ? 'on' : '',
			onclick: () => { state.viewport = key; render(); },
		}, key === 'desktop' ? 'Desktop' : 'Mobile'));
	}
	return seg;
}

function renderGeneration(project, gen) {
	const wrap = el('div', {});
	const running = gen.variants.some((v) => v.status === 'running' || v.status === 'pending');
	const title = gen.kind === 'drop' ? 'Dropped by your agent' : gen.kind === 'import' ? 'Imported reference' : gen.kind === 'refine' ? `Refinement — "${gen.prompt || 'pinned comments'}"` : 'Art directions from the brief';

	wrap.append(el('div', { class: 'gen-header' },
		el('span', { class: 'title' }, title),
		el('span', { class: 'meta' }, [gen.provider, gen.model, timeAgo(gen.createdAt)].filter(Boolean).join(' · ')),
		running ? el('button', { class: 'btn small', onclick: () => api('POST', gUrl(gen, 'cancel')).then(scheduleRefresh).catch(fail) }, '◼ Cancel') : null,
		!running && isLeaf(project, gen) && project.generations.length > 1
			? el('button', { class: 'btn small ghost', onclick: () => deleteGenerationAction(gen) }, '✕')
			: null));

	if (gen.decision) {
		wrap.append(el('div', { class: 'decision-banner' },
			el('b', {}, `Picked v${gen.decision.variant + 1}`),
			el('span', {}, gen.decision.note || 'No note'),
			el('span', { class: 'meta', style: 'margin-left:auto;color:var(--muted)' }, timeAgo(gen.decision.decidedAt))));
	}

	const grid = el('div', { class: 'grid' });
	for (const variant of gen.variants) grid.append(renderCard(project, gen, variant));
	wrap.append(grid);
	return wrap;
}

const isLeaf = (project, gen) => !project.generations.some((g) => g.parent?.generationId === gen.id);

function gUrl(gen, tail = '') {
	return `/api/projects/${state.project.id}/generations/${gen.id}${tail ? `/${tail}` : ''}`;
}

function vUrl(gen, variant, tail = '') {
	return `${gUrl(gen, 'variants')}/${variant.index}${tail ? `/${tail}` : ''}`;
}

/* ---------- variant cards ---------- */

const iframeCache = new Map();
const resizeObserver = new ResizeObserver((entries) => {
	for (const entry of entries) fitPreview(entry.target);
});

function fitPreview(preview) {
	const iframe = preview.querySelector('iframe');
	if (!iframe) return;
	const vp = VIEWPORTS[state.viewport];
	const scale = Math.min(preview.clientWidth / vp.w, preview.clientHeight / vp.h);
	iframe.style.transform = `scale(${scale})`;
	iframe.style.left = `${Math.max(0, (preview.clientWidth - vp.w * scale) / 2)}px`;
}

function renderCard(project, gen, variant) {
	const selected = state.selection?.genId === gen.id && state.selection?.index === variant.index;
	const picked = gen.decision?.variant === variant.index;
	const card = el('div', { class: `card ${selected ? 'selected' : ''}` });
	if (picked) card.append(el('div', { class: 'ribbon' }, 'picked'));

	if (variant.status === 'done') {
		card.append(renderPreview(project, gen, variant, selected));
	} else if (variant.status === 'error') {
		card.append(el('div', { class: 'state-card' },
			el('div', { class: 'err' }, '✕ ', (variant.error || 'Failed').split('—')[0]),
			variant.error?.includes('—') ? el('details', { class: 'errbox' }, el('summary', {}, 'details'), el('pre', {}, variant.error)) : null,
			gen.kind !== 'drop' && gen.kind !== 'import'
				? el('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); retry(gen, variant); } }, '↻ Retry')
				: null));
	} else {
		card.append(el('div', { class: 'state-card' },
			el('span', { html: SPARK, class: 'spark-spin' }),
			el('div', {}, variant.status === 'pending' ? 'Queued…' : `${providerLabel(variant.provider)} is designing…`),
			el('div', { class: 'shimmer' }),
			variant.startedAt ? el('div', { class: 'prov elapsed', 'data-start': variant.startedAt }, '') : null));
	}

	const foot = el('div', { class: 'card-foot' },
		el('span', { class: 'dir' }, variant.direction?.label || (variant.take ? variant.take.split('—')[0].trim() : `v${variant.index + 1}`)),
		el('span', { class: 'prov' }, [providerLabel(variant.provider), fmtDur(variant.durationMs)].filter(Boolean).join(' · ')),
		variant.comments?.length ? el('span', { class: 'comment-count' }, `● ${variant.comments.length}`) : null,
		el('span', { class: 'spacer' }));

	if (variant.status === 'done') {
		foot.append(
			el('button', {
				class: `btn small icon ghost star ${variant.favorite ? 'on' : ''}`,
				title: 'Favorite',
				onclick: (e) => { e.stopPropagation(); api('POST', vUrl(gen, variant, 'favorite'), { value: !variant.favorite }).then(scheduleRefresh).catch(fail); },
			}, variant.favorite ? '★' : '☆'),
			el('button', { class: 'btn small icon ghost', title: 'Open full size', onclick: (e) => { e.stopPropagation(); window.open(vUrl(gen, variant, 'html'), '_blank', 'noopener,noreferrer'); } }, '⤢'),
			gen.kind !== 'drop' && gen.kind !== 'import'
				? el('button', { class: 'btn small icon ghost', title: 'Regenerate', onclick: (e) => { e.stopPropagation(); retry(gen, variant); } }, '↻')
				: null,
			el('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); exportMenu(e, gen, variant); } }, 'Export ▾'));
	}
	card.append(foot);

	card.addEventListener('click', () => {
		if (!selected && variant.status === 'done') {
			state.selection = { genId: gen.id, index: variant.index };
			render();
		}
	});
	return card;
}

function providerLabel(pid) {
	return pid === 'claude-cli' ? 'claude' : pid === 'codex-cli' ? 'codex' : pid === 'anthropic-api' ? 'api' : pid || '';
}

function renderPreview(project, gen, variant, selected) {
	const preview = el('div', { class: 'preview' });
	const vp = VIEWPORTS[state.viewport];
	const key = `${project.id}:${gen.id}:${variant.index}:${variant.file}:${state.viewport}`;
	let iframe = iframeCache.get(key);
	if (!iframe) {
		iframe = el('iframe', { src: vUrl(gen, variant, 'html'), sandbox: 'allow-scripts', loading: 'lazy' });
		iframeCache.set(key, iframe);
		if (iframeCache.size > 60) iframeCache.delete(iframeCache.keys().next().value);
	}
	iframe.width = vp.w;
	iframe.height = vp.h;
	preview.append(iframe);

	const veil = el('div', { class: 'veil' });
	veil.addEventListener('click', (event) => {
		event.stopPropagation();
		if (!selected) {
			state.selection = { genId: gen.id, index: variant.index };
			render();
			return;
		}
		const rect = veil.getBoundingClientRect();
		openPinInput(preview, gen, variant, ((event.clientX - rect.left) / rect.width) * 100, ((event.clientY - rect.top) / rect.height) * 100);
	});
	preview.append(veil);

	for (const [i, comment] of (variant.comments || []).entries()) {
		if (comment.x == null) continue;
		preview.append(el('div', {
			class: 'pin',
			style: `left:${comment.x}%;top:${comment.y}%`,
			title: comment.text,
			onclick: (e) => { e.stopPropagation(); pinMenu(e, gen, variant, comment); },
		}, String(i + 1)));
	}

	resizeObserver.observe(preview);
	requestAnimationFrame(() => fitPreview(preview));
	return preview;
}

function openPinInput(preview, gen, variant, x, y) {
	preview.querySelector('.pin-input')?.remove();
	const input = el('input', { type: 'text', placeholder: 'Pin a comment…' });
	const box = el('div', { class: 'pin-input', style: `left:${Math.min(x, 62)}%;top:${Math.min(y, 82)}%`, onclick: (e) => e.stopPropagation() }, input);
	preview.append(box);
	input.focus();
	input.addEventListener('keydown', async (event) => {
		if (event.key === 'Escape') box.remove();
		if (event.key === 'Enter' && input.value.trim()) {
			try {
				await api('POST', vUrl(gen, variant, 'comments'), { text: input.value.trim(), x, y });
				box.remove();
				scheduleRefresh();
			} catch (err) { fail(err); }
		}
	});
}

function pinMenu(event, gen, variant, comment) {
	openMenu(event, [
		{ label: comment.text, disabled: true },
		{ sep: true },
		{
			label: '✕ Delete pin',
			action: () => api('DELETE', `${vUrl(gen, variant, 'comments')}/${comment.id}`).then(scheduleRefresh).catch(fail),
		},
	]);
}

function retry(gen, variant) {
	api('POST', vUrl(gen, variant, 'retry'), { provider: state.settings.provider, model: state.settings.model || undefined })
		.then(scheduleRefresh)
		.catch(fail);
}

/* ---------- export menu ---------- */

function exportMenu(event, gen, variant) {
	const showSvg = gen.mode === 'illustration' || gen.kind === 'import' || gen.kind === 'drop';
	openMenu(event, [
		{ label: 'Copy HTML', action: async () => copyText(await (await fetch(vUrl(gen, variant, 'html'))).text(), 'HTML copied') },
		{ label: 'Download HTML', action: () => window.location.assign(vUrl(gen, variant, 'file')) },
		{ label: 'Copy handoff prompt for your agent', action: () => copyHandoff(gen, variant) },
		{ sep: true },
		{ mlabel: 'Elementor (WordPress)' },
		{ label: 'Copy embed for an HTML widget', action: async () => copyText(await (await fetch(vUrl(gen, variant, 'elementor-blob'))).text(), 'Embed copied — paste into an Elementor HTML widget') },
		{ label: 'Download template (containers)', action: () => window.location.assign(`${vUrl(gen, variant, 'elementor')}?structure=container&sliced=1`) },
		{ label: 'Download template (legacy sections)', action: () => window.location.assign(`${vUrl(gen, variant, 'elementor')}?structure=section&sliced=1`) },
		{ label: '✦ Convert to native widgets (AI, experimental)', action: () => convert(gen, variant) },
		...(showSvg ? [
			{ sep: true },
			{ mlabel: 'Figma' },
			{ label: 'Copy SVG (paste into Figma)', action: async () => {
				const response = await fetch(vUrl(gen, variant, 'svg'));
				if (!response.ok) throw new Error('This variant contains no SVG');
				copyText(await response.text(), 'SVG copied — paste into Figma');
			} },
			{ label: 'Download SVG', action: () => window.location.assign(vUrl(gen, variant, 'svg')) },
		] : []),
	]);
}

function convert(gen, variant) {
	if (!state.settings.provider) return toast('No provider available', 'err');
	api('POST', vUrl(gen, variant, 'convert'), {
		provider: state.settings.provider,
		model: state.settings.model || undefined,
		structure: 'container',
	}).then((task) => {
		pendingConverts.add(task.id);
		toast('Converting to native Elementor widgets — the download starts when it\'s ready (this can take a few minutes).');
	}).catch(fail);
}

async function copyHandoff(gen, variant) {
	const project = state.project;
	const lines = [
		`# Design handoff from Fabma`,
		``,
		`Project: ${project.name}`,
		`Brief: ${project.brief}`,
		``,
		`Chosen design (self-contained HTML): ${variant.path}`,
	];
	if (gen.parent) {
		const parent = project.generations.find((g) => g.id === gen.parent.generationId);
		const pv = parent?.variants[gen.parent.variant];
		if (pv?.refPaths?.image) lines.push(`Baseline screenshot of the real app: ${pv.refPaths.image}`);
		if (pv?.refPaths?.markup) lines.push(`Baseline markup: ${pv.refPaths.markup}`);
	}
	if (gen.decision?.note) lines.push(``, `Decision note: ${gen.decision.note}`);
	const comments = (variant.comments || []).map((c, i) =>
		c.x != null ? `${i + 1}. At ~${Math.round(c.x)}% left / ${Math.round(c.y)}% top: ${c.text}` : `${i + 1}. ${c.text}`);
	if (comments.length) lines.push(``, `Comments:`, ...comments);
	lines.push(``, `Task: implement this design faithfully in the real codebase. The HTML is a mockup — reuse the project's actual components, tokens and conventions rather than copying markup verbatim.`);
	copyText(lines.join('\n'), 'Handoff prompt copied — paste it to Claude Code / Codex');
}

/* ---------- generic menu ---------- */

function closeMenus() {
	document.querySelectorAll('.menu').forEach((m) => m.remove());
}

function openMenu(event, items) {
	closeMenus();
	const menu = el('div', { class: 'menu' });
	for (const item of items) {
		if (item.sep) { menu.append(el('div', { class: 'sep' })); continue; }
		if (item.mlabel) { menu.append(el('div', { class: 'mlabel' }, item.mlabel)); continue; }
		menu.append(el('button', {
			disabled: !!item.disabled,
			onclick: async () => {
				closeMenus();
				try { await item.action?.(); } catch (err) { fail(err); }
			},
		}, item.label));
	}
	document.body.append(menu);
	const rect = menu.getBoundingClientRect();
	menu.style.left = `${Math.min(event.clientX, window.innerWidth - rect.width - 12)}px`;
	menu.style.top = `${Math.min(event.clientY + 6, window.innerHeight - rect.height - 12)}px`;
	setTimeout(() => document.addEventListener('click', closeMenus, { once: true }));
}

/* ---------- dock ---------- */

function renderDock(project, gen) {
	const selection = state.selection && project.generations.find((g) => g.id === state.selection.genId);
	const variant = selection?.variants[state.selection.index];
	const dock = el('div', { class: 'dock' });

	if (variant) {
		const pinCount = (variant.comments || []).length;
		dock.append(el('div', { class: 'context' },
			el('b', {}, `Refining v${variant.index + 1}`),
			variant.direction ? el('span', {}, `· ${variant.direction.label}`) : null,
			el('span', {}, pinCount ? `· ${pinCount} pinned comment${pinCount > 1 ? 's' : ''} included` : '· click on the design to pin comments'),
			el('button', { class: 'btn small ghost', style: 'margin-left:auto', onclick: () => { state.selection = null; render(); } }, 'esc'),
			el('button', { class: 'btn small', onclick: () => decideModal(selection, variant) }, '✓ Decide')));
		const textarea = el('textarea', { placeholder: 'What should change? Pinned comments come along automatically…' });
		dock.append(textarea);
		dock.append(dockRow(project, () => {
			const feedback = textarea.value.trim();
			if (!feedback && !pinCount) return toast('Give some feedback first — a note or at least one pin', 'err');
			generate({
				prompt: feedback,
				count: state.settings.refineCount,
				parent: { generationId: selection.id, variant: variant.index },
				mode: selection.mode,
			});
		}, true));
	} else {
		dock.append(el('div', { class: 'context' },
			el('b', {}, gen ? 'New direction' : 'First generation'),
			el('span', {}, '· fresh variants from the brief'),
			el('span', { style: 'margin-left:auto' })));
		const textarea = el('textarea', { placeholder: 'Optional extra note for this round (e.g. “focus on the pricing story”)…', style: 'min-height:40px' });
		dock.append(textarea);
		const chips = el('div', { class: 'chips' });
		for (const direction of state.directions) {
			const on = state.chipIds.includes(direction.id);
			chips.append(el('span', {
				class: `chip ${on ? 'on' : ''}`,
				title: direction.hint,
				onclick: () => {
					state.chipIds = on ? state.chipIds.filter((id) => id !== direction.id) : [...state.chipIds, direction.id].slice(-6);
					render();
				},
			}, direction.label));
		}
		dock.append(chips);
		dock.append(dockRow(project, () => generate({
			prompt: textarea.value.trim(),
			count: state.settings.count,
			directionIds: state.chipIds,
			mode: project.mode,
		}), false));
	}

	dock.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') dock.querySelector('.btn.primary')?.click();
		if (event.key === 'Escape') { state.selection = null; render(); }
	});
	return dock;
}

function dockRow(project, onGenerate, refine) {
	const providerSelect = el('select', {
		onchange: (e) => { state.settings.provider = e.target.value; persistSettings(); },
	});
	for (const provider of state.providers) {
		providerSelect.append(el('option', {
			value: provider.id,
			selected: provider.id === state.settings.provider,
			disabled: !provider.available,
		}, `${provider.label}${provider.available ? '' : ' (unavailable)'}`));
	}
	const modelInput = el('input', {
		type: 'text', class: 'model', placeholder: 'model (default)', value: state.settings.model,
		onchange: (e) => { state.settings.model = e.target.value.trim(); persistSettings(); },
	});
	const countSelect = el('select', {
		onchange: (e) => {
			state.settings[refine ? 'refineCount' : 'count'] = Number(e.target.value);
			persistSettings();
		},
	});
	for (const n of [1, 2, 3, 4, 6]) {
		countSelect.append(el('option', { value: n, selected: n === (refine ? state.settings.refineCount : state.settings.count) }, `×${n}`));
	}
	return el('div', { class: 'row' },
		providerSelect, modelInput, countSelect,
		el('span', { class: 'grow-space' }),
		el('button', { class: 'btn primary', onclick: onGenerate }, refine ? '✳ Refine' : '✳ Generate'));
}

async function generate(opts) {
	if (!state.settings.provider) return toast('No provider available — install/log in to Claude Code or Codex, or set ANTHROPIC_API_KEY', 'err');
	try {
		const generation = await api('POST', `/api/projects/${state.project.id}/generations`, {
			...opts,
			provider: state.settings.provider,
			model: state.settings.model || undefined,
		});
		state.activeGenId = generation.id;
		state.selection = null;
		scheduleRefresh();
	} catch (err) { fail(err); }
}

/* ---------- modals ---------- */

function modal(...children) {
	const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) overlay.remove(); } });
	const box = el('div', { class: 'modal' }, ...children);
	overlay.append(box);
	overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
	document.body.append(overlay);
	box.querySelector('input, textarea')?.focus();
	return overlay;
}

function newProjectModal() {
	const name = el('input', { type: 'text', placeholder: 'e.g. Brewday landing' });
	const brief = el('textarea', { placeholder: 'The content & requirements — product, audience, copy points, must-haves. This is locked context for every generation.' });
	const mode = el('select', {},
		el('option', { value: 'page' }, 'Page — a complete web page'),
		el('option', { value: 'section' }, 'Section — one standout block'),
		el('option', { value: 'illustration' }, 'Illustration — SVG artwork for Figma'));
	const autogen = el('input', { type: 'checkbox', checked: true, style: 'width:auto' });
	const overlay = modal(
		el('h2', {}, 'New project'),
		el('label', { class: 'field' }, 'Name', name),
		el('label', { class: 'field' }, 'Mode', mode),
		el('label', { class: 'field' }, 'Brief', brief),
		el('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:8px' }, autogen, ' Generate the first variants right away'),
		el('div', { class: 'actions' },
			el('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
			el('button', {
				class: 'btn primary',
				onclick: async () => {
					if (!brief.value.trim()) return toast('A brief is required — it is the locked content for every variant', 'err');
					try {
						const project = await api('POST', '/api/projects', { name: name.value.trim() || 'Untitled', brief: brief.value.trim(), mode: mode.value });
						overlay.remove();
						state.projects = await api('GET', '/api/projects');
						location.hash = `#/p/${project.id}`;
						if (autogen.checked && state.settings.provider) {
							await openProject(project.id);
							await generate({ count: state.settings.count, mode: mode.value, directionIds: [] });
						}
					} catch (err) { fail(err); }
				},
			}, '✳ Create')));
}

function importModal() {
	const screenshot = el('input', { type: 'file', accept: '.png,.jpg,.jpeg,.webp' });
	const markup = el('input', { type: 'file', accept: '.html,.htm,.svg' });
	const note = el('input', { type: 'text', placeholder: 'What is this? (e.g. “current dashboard header”)' });
	const overlay = modal(
		el('h2', {}, 'Import a reference'),
		el('p', { class: 'hint' }, 'Bring the real thing in: a screenshot of your app (from Playwright or ⌘⇧4), an exported Figma SVG, or an HTML file. Then select it and refine — the AI will mock changes on top of it.'),
		el('label', { class: 'field' }, 'Screenshot (png/jpg/webp)', screenshot),
		el('label', { class: 'field' }, 'Markup (html/svg) — optional, improves fidelity', markup),
		el('label', { class: 'field' }, 'Note', note),
		el('div', { class: 'actions' },
			el('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
			el('button', {
				class: 'btn primary',
				onclick: async () => {
					const files = [];
					for (const input of [screenshot, markup]) {
						const file = input.files?.[0];
						if (file) files.push({ name: file.name, dataBase64: await fileToBase64(file) });
					}
					if (!files.length) return toast('Choose at least one file', 'err');
					try {
						const generation = await api('POST', `/api/projects/${state.project.id}/import`, { files, note: note.value.trim() });
						overlay.remove();
						state.activeGenId = generation.id;
						scheduleRefresh();
					} catch (err) { fail(err); }
				},
			}, '⇪ Import')));
}

function decideModal(gen, variant) {
	const note = el('textarea', { placeholder: 'Optional note back to your agent — “this one, but keep the old logo”…' });
	const overlay = modal(
		el('h2', {}, `Pick v${variant.index + 1}`),
		el('p', { class: 'hint' }, 'This records your decision. An agent waiting on this session gets it immediately, along with all pinned comments.'),
		el('label', { class: 'field' }, 'Note', note),
		el('div', { class: 'actions' },
			el('button', { class: 'btn', onclick: () => overlay.remove() }, 'Cancel'),
			el('button', {
				class: 'btn primary',
				onclick: async () => {
					try {
						await api('POST', gUrl(gen, 'decide'), { variant: variant.index, note: note.value.trim() });
						overlay.remove();
						toast('Decision recorded', 'ok');
						scheduleRefresh();
					} catch (err) { fail(err); }
				},
			}, '✓ Decide')));
}

/* ---------- destructive actions ---------- */

function deleteProjectAction() {
	if (!confirm(`Delete "${state.project.name}" and all its generations?`)) return;
	api('DELETE', `/api/projects/${state.project.id}`)
		.then(async () => {
			state.projects = await api('GET', '/api/projects');
			location.hash = '#/';
		})
		.catch(fail);
}

function deleteGenerationAction(gen) {
	if (!confirm('Delete this generation and its variants?')) return;
	api('DELETE', gUrl(gen))
		.then(() => { state.activeGenId = null; scheduleRefresh(); })
		.catch(fail);
}

/* ---------- welcome ---------- */

function renderWelcome() {
	const none = !state.providers.some((p) => p.available);
	return el('div', { class: 'content' }, el('div', { class: 'welcome' },
		el('span', { html: SPARK, class: 'spark' }),
		el('h1', {}, 'Stop making AI drive design tools. ', el('em', {}, 'Give it a medium it speaks.')),
		el('p', {}, 'Fabma turns a brief into competing art directions — real, rendered, self-contained HTML — using the Claude Code or Codex subscription you already have. You pick, pin comments, refine. Then export clean HTML, an Elementor template for WordPress, or SVG you can paste straight into Figma.'),
		none ? el('div', { class: 'warn' }, 'No provider detected. Install & log in to Claude Code or Codex, or set ANTHROPIC_API_KEY, then restart fabma.') : null,
		el('div', {}, el('button', { class: 'btn primary', onclick: newProjectModal }, '✳ New project')),
		el('p', {}, 'Working with an agent in a chat? Have it drop its own variants here and wait for your verdict:'),
		el('pre', { html: `<b>fabma drop</b> header-a.html header-b.html --title "Header options" <b>--wait</b>\n<span style="opacity:.6"># blocks until you decide in this UI, then prints your pick + pinned comments</span>\n\nagents can read the full API at <b>/agent.md</b>` })));
}

/* ---------- elapsed timers ---------- */

function tickElapsed() {
	document.querySelectorAll('.elapsed').forEach((node) => {
		const started = new Date(node.dataset.start).getTime();
		node.textContent = `${Math.max(0, Math.round((Date.now() - started) / 1000))}s`;
	});
}

boot().catch((err) => {
	document.body.innerHTML = `<pre style="padding:40px;color:#e08f6a">fabma failed to start: ${err.message}</pre>`;
});
