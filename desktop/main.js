import { app, BrowserWindow, shell } from 'electron';

const PORT = Number(process.env.FABMA_PORT) || 4011;
const URL = `http://localhost:${PORT}`;

async function serverAlreadyRunning() {
	try {
		const response = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1200) });
		return response.ok;
	} catch {
		return false;
	}
}

app.whenReady().then(async () => {
	// Attach to a running playground (e.g. started by an agent) or host our own.
	if (!(await serverAlreadyRunning())) {
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
	window.loadURL(URL);
	// Full-size previews and downloads open in the real browser.
	window.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: 'deny' };
	});
});

app.on('window-all-closed', () => app.quit());
