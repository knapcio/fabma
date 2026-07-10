import fs from 'node:fs';
import path from 'node:path';
import { runCli } from './spawn.js';

// OpenAI Codex CLI, non-interactive. workspace-write sandboxes writes to the
// job dir; -o captures the final message as a fallback source.
export default {
	id: 'codex-cli',
	label: 'Codex',
	kind: 'cli',
	bin: 'codex',
	supportsFiles: true,
	defaultModel: null, // uses the user's Codex default

	async generate({ prompt, jobdir, model, timeoutMs, onSpawn }) {
		const lastMessageFile = path.join(jobdir, '.last-message.txt');
		const args = [
			'exec',
			'--sandbox', 'workspace-write',
			'--skip-git-repo-check',
			'--color', 'never',
			'-C', jobdir,
			'-o', lastMessageFile,
		];
		if (model) args.push('-m', model);
		args.push(prompt);
		const result = await runCli('codex', args, { jobdir, timeoutMs, onSpawn });
		try {
			result.fallbackText = fs.readFileSync(lastMessageFile, 'utf8');
		} catch { /* stdout fallback remains */ }
		return result;
	},
};
