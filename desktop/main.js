import { app, BrowserWindow, shell } from 'electron';

const PORT = Number(process.env.FABMA_PORT) || 4011;
const BASE = `http://localhost:${PORT}`;

// A 2xx alone isn't proof it's fabma on this port — check its signature.
async function fabmaAlreadyRunning() {
	try {
		const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
		if (!response.ok) return false;
		const health = await response.json();
		return health.ok === true && typeof health.workspace === 'string';
	} catch {
		return false;
	}
}

app.whenReady().then(async () => {
	// Attach to a running playground (e.g. started by an agent) or host our own.
	if (!(await fabmaAlreadyRunning())) {
		const { start } = await import('../server/index.js');
		start({ port: PORT, open: false });
	}

	const window = new BrowserWindow({
		width: 1560,
		height: 980,
		titleBarStyle: 'hiddenInset',
		backgroundColor: '#141110',
		webPreferences: { contextIsolation: true },
	});
	window.loadURL(BASE);
	// Only fabma's own URLs (full-size previews, downloads) may leave the
	// window — and only into the default browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith(`${BASE}/`)) shell.openExternal(url);
		return { action: 'deny' };
	});
});

app.on('window-all-closed', () => app.quit());
