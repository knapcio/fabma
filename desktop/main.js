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
		start({ port: PORT, open: false, flavor: 'desktop' });
	}

	const window = new BrowserWindow({
		width: 1560,
		height: 980,
		minWidth: 980,
		minHeight: 640,
		titleBarStyle: 'hiddenInset',
		backgroundColor: '#141110',
		webPreferences: { contextIsolation: true },
	});
	window.loadURL(BASE);

	// Full-size previews open as in-app windows (they carry fabma's preview
	// CSP, so they can't reach the API or the network). Anything else stays
	// closed — designs cannot navigate out.
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith(`${BASE}/`)) {
			return {
				action: 'allow',
				overrideBrowserWindowOptions: {
					width: 1440,
					height: 940,
					backgroundColor: '#ffffff',
					webPreferences: { contextIsolation: true, sandbox: true },
				},
			};
		}
		return { action: 'deny' };
	});

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) window.show();
	});
});

app.on('window-all-closed', () => app.quit());
