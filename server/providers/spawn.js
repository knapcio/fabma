import { spawn } from 'node:child_process';
import { cleanEnv } from '../util.js';

const OUTPUT_CAP = 2 * 1024 * 1024;

// Shared CLI runner: spawn in the job dir, capture capped output, enforce a
// timeout, and let the caller register the child for cancellation.
export function runCli(bin, args, { jobdir, timeoutMs, onSpawn }) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { cwd: jobdir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
		onSpawn?.(child);

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const append = (current, chunk) =>
			current.length < OUTPUT_CAP ? current + chunk.toString('utf8') : current;
		child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
		child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 5000).unref();
		}, timeoutMs);

		child.on('error', (err) => {
			clearTimeout(timer);
			reject(new Error(`Failed to start ${bin}: ${err.message}`));
		});

		child.on('close', (code, signal) => {
			clearTimeout(timer);
			resolve({
				exitCode: code,
				signal,
				timedOut,
				killed: child.killed && !timedOut,
				stdout,
				stderr,
				fallbackText: stdout,
			});
		});
	});
}
