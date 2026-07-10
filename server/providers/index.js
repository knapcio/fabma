import { execFile } from 'node:child_process';
import claudeCli from './claude-cli.js';
import codexCli from './codex-cli.js';
import anthropicApi from './anthropic-api.js';

export const PROVIDERS = [claudeCli, codexCli, anthropicApi];

export const getProvider = (id) => PROVIDERS.find((p) => p.id === id);

let cache = { at: 0, list: null };

export async function detectProviders() {
	if (cache.list && Date.now() - cache.at < 60000) return cache.list;
	const list = await Promise.all(PROVIDERS.map(async (p) => {
		if (p.kind === 'cli') {
			const found = await which(p.bin);
			return {
				id: p.id,
				label: p.label,
				kind: p.kind,
				available: !!found,
				detail: found ? `${p.bin} CLI` : `${p.bin} CLI not found on PATH`,
			};
		}
		const hasKey = !!process.env.ANTHROPIC_API_KEY;
		return {
			id: p.id,
			label: p.label,
			kind: p.kind,
			available: hasKey,
			detail: hasKey ? p.defaultModel : 'set ANTHROPIC_API_KEY to enable',
		};
	}));
	cache = { at: Date.now(), list };
	return list;
}

const which = (bin) => new Promise((resolve) => {
	execFile('which', [bin], (err, stdout) => resolve(err ? null : stdout.trim()));
});
