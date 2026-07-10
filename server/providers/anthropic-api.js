// Direct Anthropic API provider for users without agent CLIs. No SDK — one
// fetch. Reference designs are inlined into the prompt; screenshots go in as
// image content blocks.
export default {
	id: 'anthropic-api',
	label: 'Anthropic API',
	kind: 'api',
	supportsFiles: false,
	defaultModel: 'claude-sonnet-5',

	async generate({ prompt, model, timeoutMs, attachments = [], onSpawn }) {
		const controller = new AbortController();
		onSpawn?.({ kill: () => controller.abort() });
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const content = [
				...attachments
					.filter((a) => a.kind === 'image')
					.map((a) => ({
						type: 'image',
						source: { type: 'base64', media_type: a.mediaType, data: a.dataBase64 },
					})),
				{ type: 'text', text: prompt },
			];
			const body = {
				model: model || this.defaultModel,
				max_tokens: 32000,
				messages: [{ role: 'user', content }],
			};
			let response = await postMessages(body, controller.signal);
			if (!response.ok) {
				const errText = await response.text();
				// Some models cap max_tokens lower; retry once at a safe value.
				if (response.status === 400 && /max_tokens/i.test(errText)) {
					response = await postMessages({ ...body, max_tokens: 8192 }, controller.signal);
				}
				if (!response.ok) {
					throw new Error(`Anthropic API ${response.status}: ${(errText || await response.text()).slice(0, 400)}`);
				}
			}
			const data = await response.json();
			const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
			return { exitCode: 0, stdout: text, stderr: '', fallbackText: text };
		} finally {
			clearTimeout(timer);
		}
	},
};

function postMessages(body, signal) {
	return fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		signal,
		headers: {
			'content-type': 'application/json',
			'x-api-key': process.env.ANTHROPIC_API_KEY,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify(body),
	});
}
