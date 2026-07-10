// Fast sanity check without any AI calls: boots the server on a scratch
// workspace, exercises the drop → comment → decide → feedback loop and the
// exporters. `npm run smoke`.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from '../server/index.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fabma-smoke-'));
const port = 4900 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;
const server = start({ workspace, port, open: false });

const api = async (method, url, body) => {
	const response = await fetch(`${base}${url}`, {
		method,
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	assert.ok(response.ok, `${method} ${url} → ${response.status}`);
	return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
};

try {
	await new Promise((resolve) => server.on('listening', resolve));

	const health = await api('GET', '/api/health');
	assert.equal(health.ok, true);
	assert.ok((await api('GET', '/')).includes('fabma'), 'UI is served');
	assert.ok((await api('GET', '/agent.md')).includes('fabma drop'), 'AGENT.md is served');

	const html = '<!doctype html><html><head><style>:root{--a:#f00}body{color:var(--a)}</style></head><body><section><h1>Hi</h1></section><section><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg></section></body></html>';
	const drop = await api('POST', '/api/drop', { title: 'Smoke', variants: [{ name: 'A', html }, { name: 'B', html }] });
	assert.ok(drop.url.includes(drop.projectId));

	const commentsUrl = `/api/projects/${drop.projectId}/generations/${drop.generationId}/variants/1/comments`;
	await api('POST', commentsUrl, { text: 'pin here', x: 33, y: 66 });

	const waiting = api('GET', `/api/projects/${drop.projectId}/generations/${drop.generationId}/feedback?wait=15`);
	await new Promise((resolve) => setTimeout(resolve, 300));
	await api('POST', `/api/projects/${drop.projectId}/generations/${drop.generationId}/decide`, { variant: 1, note: 'B wins' });
	const feedback = await waiting;
	assert.equal(feedback.status, 'decided');
	assert.equal(feedback.decision.variant, 1);
	assert.equal(feedback.variants[1].comments[0].x, 33);

	// Round 2 into the same session + the discussion thread.
	const round2 = await api('POST', '/api/drop', { projectId: drop.projectId, note: 'refined takes', variants: [{ name: 'B2', html }] });
	assert.equal(round2.projectId, drop.projectId);
	const waitingMsg = api('GET', `/api/projects/${drop.projectId}/messages?wait=15&after=${(await api('GET', `/api/projects/${drop.projectId}/messages`)).at(-1).id}`);
	await new Promise((resolve) => setTimeout(resolve, 200));
	await api('POST', `/api/projects/${drop.projectId}/messages`, { from: 'human', text: 'love B2' });
	const newMessages = await waitingMsg;
	assert.equal(newMessages.at(-1).text, 'love B2');
	const project = await api('GET', `/api/projects/${drop.projectId}`);
	assert.equal(project.generations.length, 2);
	assert.ok(project.messages.some((m) => m.from === 'agent' && m.text === 'refined takes'));

	const template = await api('GET', `/api/projects/${drop.projectId}/generations/${drop.generationId}/variants/0/elementor?sliced=1`);
	assert.equal(template.content.length, 2);
	assert.equal(template.content[0].elements[0].widgetType, 'html');
	assert.ok(template.content[0].elements[0].settings.html.includes('.fabma-'), 'CSS is scoped');

	const svg = await api('GET', `/api/projects/${drop.projectId}/generations/${drop.generationId}/variants/0/svg`);
	assert.ok(svg.includes('<svg'), 'SVG export works');

	console.log('smoke: all good ✳');
	process.exit(0);
} catch (err) {
	console.error('smoke failed:', err.message);
	process.exit(1);
} finally {
	server.close();
	fs.rmSync(workspace, { recursive: true, force: true });
}
