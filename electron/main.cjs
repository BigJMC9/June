const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');

const isMac = process.platform === 'darwin';
let mainWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101317',
    show: false,
    autoHideMenuBar: !isMac,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow = win;

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    if (url === currentUrl || url.startsWith('file://')) return;

    event.preventDefault();
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
  });

  void win.loadFile(path.join(__dirname, '..', 'index.html'));

  if (process.env.JUNE_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function registerDesktopIpc() {
  ipcMain.handle('june:get-runtime-info', () => ({
    platform: process.platform,
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    isPackaged: app.isPackaged
  }));

  ipcMain.handle('june:select-project-directory', async () => {
    const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(parentWindow, {
      title: 'Add project to June',
      buttonLabel: 'Add project',
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const projectPath = result.filePaths[0];
    return {
      name: path.basename(projectPath),
      path: projectPath
    };
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    registerDesktopIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
