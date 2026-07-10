import { parse } from 'node-html-parser';
import { elementorId } from '../util.js';

// Deterministic HTML → Elementor export. Fidelity comes from embedding the
// design's own markup in HTML widgets with scoped CSS — this is an embedded
// design, not a natively editable template (that's what AI convert is for).

const SECTION_TAGS = new Set(['section', 'header', 'footer', 'main', 'article', 'aside', 'nav', 'div']);

export function exportTemplate(html, { title = 'Fabma design', structure = 'container', sliced = false } = {}) {
	const { slices, css, fonts } = dissect(html, sliced);
	const scope = `fabma-${elementorId()}`;
	const scopedCss = scopeCss(css, scope);
	const content = slices.map((sliceHtml, index) => {
		const widgetHtml = [
			index === 0 ? fonts : '',
			`<div class="${scope}">${sliceHtml}</div>`,
			index === 0 && scopedCss ? `<style>\n${scopedCss}\n</style>` : '',
		].filter(Boolean).join('\n');
		return wrapWidget(htmlWidget(widgetHtml), structure);
	});
	return {
		version: '0.4',
		title,
		type: 'page',
		page_settings: [],
		content,
	};
}

// Single blob for pasting into one Elementor HTML widget by hand.
export function exportBlob(html) {
	const { slices, css, fonts } = dissect(html, false);
	const scope = `fabma-${elementorId()}`;
	const scopedCss = scopeCss(css, scope);
	return [
		fonts,
		`<div class="${scope}">${slices.join('\n')}</div>`,
		scopedCss ? `<style>\n${scopedCss}\n</style>` : '',
	].filter(Boolean).join('\n');
}

function dissect(html, sliced) {
	const root = parse(html, { comment: false });
	sanitize(root);
	const css = root.querySelectorAll('style').map((s) => s.textContent).join('\n');
	const fonts = root.querySelectorAll('link')
		.filter((l) => /fonts\.googleapis|fonts\.gstatic/.test(l.getAttribute('href') || ''))
		.map((l) => l.outerHTML)
		.join('\n');

	const body = root.querySelector('body') || root;
	let nodes = body.childNodes.filter(isRenderedElement);
	// Descend through a single wrapper so each real section becomes a slice.
	if (sliced && nodes.length === 1 && SECTION_TAGS.has(nodes[0].rawTagName?.toLowerCase())) {
		const inner = nodes[0].childNodes.filter(isRenderedElement);
		if (inner.length > 1) nodes = inner;
	}
	const slices = sliced && nodes.length > 1
		? nodes.map((n) => n.outerHTML)
		: [nodes.map((n) => n.outerHTML).join('\n')];
	return { slices, css, fonts };
}

function isRenderedElement(node) {
	const tag = node.rawTagName?.toLowerCase();
	return !!tag && tag !== 'script' && tag !== 'style' && tag !== 'link';
}

// The export lands inside a real WordPress page — strip anything executable
// wherever it sits in the tree, not just at the top level.
function sanitize(root) {
	for (const node of root.querySelectorAll('script, iframe, object, embed')) node.remove();
	const walk = (node) => {
		if (node.attributes) {
			for (const name of Object.keys(node.attributes)) {
				const value = node.attributes[name] || '';
				if (/^on/i.test(name)) node.removeAttribute(name);
				else if (/^(href|src|xlink:href|action|formaction)$/i.test(name) && /^\s*javascript:/i.test(value)) node.removeAttribute(name);
			}
		}
		for (const child of node.childNodes || []) walk(child);
	};
	walk(root);
}

function htmlWidget(content) {
	return { id: elementorId(), elType: 'widget', widgetType: 'html', settings: { html: content }, elements: [], isInner: false };
}

function wrapWidget(widget, structure) {
	if (structure === 'section') {
		return {
			id: elementorId(),
			elType: 'section',
			settings: { layout: 'full_width', gap: 'no' },
			elements: [{ id: elementorId(), elType: 'column', settings: { _column_size: 100 }, elements: [widget], isInner: false }],
			isInner: false,
		};
	}
	return {
		id: elementorId(),
		elType: 'container',
		settings: { content_width: 'full', flex_gap: { unit: 'px', size: 0, column: '0', row: '0' } },
		elements: [widget],
		isInner: false,
	};
}

// Scope CSS under `.scope` so embedded designs can't leak into the host page.
// Handles nested at-rules; @keyframes/@font-face/@import pass through as-is.
// Known limits (documented): selectors inside :is()/:where() keep their commas,
// DOM ids are not rewritten, so two embeds of the SAME design may collide.
export function scopeCss(css, scope) {
	if (!css?.trim()) return '';
	return parseBlocks(stripComments(css)).map((block) => renderBlock(block, scope)).join('\n');
}

function stripComments(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseBlocks(css) {
	const blocks = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < css.length; i += 1) {
		const ch = css[i];
		if (ch === '{') depth += 1;
		if (ch === '}') {
			depth -= 1;
			if (depth === 0) {
				blocks.push(css.slice(start, i + 1));
				start = i + 1;
			}
		}
	}
	return blocks.map((b) => b.trim()).filter(Boolean);
}

function renderBlock(block, scope) {
	const braceAt = block.indexOf('{');
	const prelude = block.slice(0, braceAt).trim();
	const body = block.slice(braceAt + 1, block.lastIndexOf('}'));

	if (/^@(keyframes|font-face|import|page|property|charset)/i.test(prelude)) return block;
	if (prelude.startsWith('@')) {
		const inner = parseBlocks(body).map((b) => renderBlock(b, scope)).join('\n');
		return `${prelude} {\n${inner}\n}`;
	}
	const selectors = splitSelectors(prelude).map((sel) => scopeSelector(sel, scope)).join(', ');
	return `${selectors} { ${body.trim()} }`;
}

function splitSelectors(prelude) {
	const out = [];
	let depth = 0;
	let current = '';
	for (const ch of prelude) {
		if (ch === '(') depth += 1;
		if (ch === ')') depth -= 1;
		if (ch === ',' && depth === 0) {
			out.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) out.push(current.trim());
	return out;
}

function scopeSelector(selector, scope) {
	// Document-level selectors become the wrapper itself.
	const rewritten = selector
		.replace(/^:root\b/i, `.${scope}`)
		.replace(/^html\s+body\b/i, `.${scope}`)
		.replace(/^html\b/i, `.${scope}`)
		.replace(/^body\b/i, `.${scope}`);
	if (rewritten !== selector) return rewritten;
	if (rewritten === '*') return `.${scope} *`;
	return `.${scope} ${rewritten}`;
}
