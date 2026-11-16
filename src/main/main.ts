import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc } from './ipc';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) app.quit();

app.setName('TerminalTab');
app.setAppUserModelId('com.terminaltab.app');

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | null = null;

function windowIcon(): { icon?: string } {
  if (!app.isPackaged) return { icon: path.join(app.getAppPath(), 'assets', 'icon.png') };
  if (process.platform === 'linux') return { icon: path.join(process.resourcesPath, 'icon.png') };
  return {};
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 700,
    minHeight: 400,
    title: 'TerminalTab',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    // Packaged Windows builds take the icon from the .exe; Linux needs it set on the window.
    ...windowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // Open links (e.g. from terminal output) in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Standard Cut / Copy / Paste menu for text fields (the terminal has its own menu).
  mainWindow.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable || !mainWindow) return;
    Menu.buildFromTemplate([
      { role: 'cut', enabled: p.editFlags.canCut },
      { role: 'copy', enabled: p.editFlags.canCopy },
      { role: 'paste', enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll' },
    ]).popup({ window: mainWindow });
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const ipc = registerIpc(path.join(app.getPath('userData'), 'vault.json'), () => mainWindow);
  app.on('before-quit', () => ipc.shutdown());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
