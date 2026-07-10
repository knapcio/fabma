import { parse } from 'node-html-parser';

// Extract the design's root <svg> so it can be pasted straight into Figma.
// Only meaningful when the variant actually is an SVG illustration.
export function extractSvg(html) {
	const root = parse(html);
	const svgs = root.querySelectorAll('svg');
	if (!svgs.length) return null;
	const svg = svgs.sort((a, b) => b.outerHTML.length - a.outerHTML.length)[0];
	if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	return svg.outerHTML;
}
