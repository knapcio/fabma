import { runCli } from './spawn.js';

// Claude Code headless. `acceptEdits` lets it write ./variant.html in the job
// dir without prompting; everything else stays under the default policy.
export default {
	id: 'claude-cli',
	label: 'Claude Code',
	kind: 'cli',
	bin: 'claude',
	supportsFiles: true,
	defaultModel: null, // uses the user's Claude Code default

	async generate({ prompt, jobdir, model, timeoutMs, onSpawn }) {
		const args = ['-p', prompt, '--permission-mode', 'acceptEdits', '--max-turns', '30'];
		if (model) args.push('--model', model);
		return runCli('claude', args, { jobdir, timeoutMs, onSpawn });
	},
};
