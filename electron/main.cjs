const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const isMac = process.platform === 'darwin';
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_VISITS = 4000;
const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  'dist',
  'build',
  'target',
  'vendor',
  '__pycache__'
]);

let mainWindow = null;
let projectStorePath = null;
let projectStore = [];

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

function projectId(projectPath) {
  return Buffer.from(projectPath).toString('base64url');
}

async function loadProjectStore() {
  projectStorePath = path.join(app.getPath('userData'), 'projects.json');

  try {
    const raw = await fsp.readFile(projectStorePath, 'utf8');
    const parsed = JSON.parse(raw);
    projectStore = Array.isArray(parsed) ? parsed.filter(item =>
      item && typeof item.path === 'string' && path.isAbsolute(item.path)
    ) : [];
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to load project store:', error);
    projectStore = [];
  }
}

async function saveProjectStore() {
  if (!projectStorePath) return;
  await fsp.mkdir(path.dirname(projectStorePath), { recursive: true });
  await fsp.writeFile(projectStorePath, JSON.stringify(projectStore, null, 2), 'utf8');
}

async function addProject(projectPath) {
  const resolved = path.resolve(projectPath);
  const stat = await fsp.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Selected project is not a directory.');

  const existing = projectStore.find(item => path.resolve(item.path) === resolved);
  if (existing) {
    existing.lastOpenedAt = new Date().toISOString();
    await saveProjectStore();
    return existing;
  }

  const project = {
    id: projectId(resolved),
    name: path.basename(resolved) || resolved,
    path: resolved,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString()
  };

  projectStore.unshift(project);
  await saveProjectStore();
  return project;
}

function getProject(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) {
    throw new Error('Invalid project path.');
  }

  const resolved = path.resolve(projectPath);
  const project = projectStore.find(item => path.resolve(item.path) === resolved);
  if (!project) throw new Error('Project is not authorised in June.');
  return project;
}

function resolveProjectPath(projectPath, relativePath = '') {
  const project = getProject(projectPath);
  const root = path.resolve(project.path);
  const target = path.resolve(root, relativePath || '.');
  const rel = path.relative(root, target);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes the selected project.');
  }

  return { project, root, target, relative: rel === '' ? '' : rel };
}

function toPosixRelative(value) {
  return value.split(path.sep).join('/');
}

function shouldSkipEntry(name, options = {}) {
  if (!options.showHidden && name.startsWith('.')) return true;
  if (options.excludeCommon !== false && DEFAULT_EXCLUDED_DIRS.has(name)) return true;
  return false;
}

async function listDirectory(projectPath, relativePath = '', options = {}) {
  const { target, root } = resolveProjectPath(projectPath, relativePath);
  const stat = await fsp.stat(target);
  if (!stat.isDirectory()) throw new Error('Requested path is not a directory.');

  const entries = await fsp.readdir(target, { withFileTypes: true });
  const visible = entries
    .filter(entry => !shouldSkipEntry(entry.name, options))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

  return Promise.all(visible.map(async entry => {
    const absolute = path.join(target, entry.name);
    const relative = toPosixRelative(path.relative(root, absolute));
    let size = null;
    let modifiedAt = null;

    try {
      const itemStat = await fsp.lstat(absolute);
      size = itemStat.isFile() ? itemStat.size : null;
      modifiedAt = itemStat.mtime.toISOString();
    } catch {
      // The file may have changed between readdir and stat. Keep the entry visible.
    }

    return {
      name: entry.name,
      path: relative,
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      size,
      modifiedAt
    };
  }));
}

async function readTextFile(projectPath, relativePath, maxBytes = MAX_PREVIEW_BYTES) {
  const { target, root } = resolveProjectPath(projectPath, relativePath);
  const stat = await fsp.stat(target);

  if (!stat.isFile()) throw new Error('Requested path is not a file.');

  const limit = Math.max(1024, Math.min(Number(maxBytes) || MAX_PREVIEW_BYTES, 8 * 1024 * 1024));
  if (stat.size > limit) {
    return {
      path: toPosixRelative(path.relative(root, target)),
      size: stat.size,
      tooLarge: true,
      binary: false,
      content: ''
    };
  }

  const buffer = await fsp.readFile(target);
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  const binary = sample.includes(0);

  return {
    path: toPosixRelative(path.relative(root, target)),
    size: stat.size,
    tooLarge: false,
    binary,
    content: binary ? '' : buffer.toString('utf8')
  };
}

async function searchFiles(projectPath, query, options = {}) {
  const { root } = resolveProjectPath(projectPath, '');
  const needle = String(query || '').trim().toLowerCase();
  if (needle.length < 2) return [];

  const results = [];
  const queue = [''];
  let visits = 0;

  while (queue.length && results.length < MAX_SEARCH_RESULTS && visits < MAX_SEARCH_VISITS) {
    const currentRelative = queue.shift();
    const currentAbsolute = path.join(root, currentRelative);

    let entries;
    try {
      entries = await fsp.readdir(currentAbsolute, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS || visits >= MAX_SEARCH_VISITS) break;
      visits += 1;
      if (shouldSkipEntry(entry.name, options)) continue;

      const relative = path.join(currentRelative, entry.name);
      const posixPath = toPosixRelative(relative);

      if (entry.name.toLowerCase().includes(needle) || posixPath.toLowerCase().includes(needle)) {
        results.push({
          name: entry.name,
          path: posixPath,
          type: entry.isDirectory() ? 'directory' : 'file'
        });
      }

      if (entry.isDirectory()) queue.push(relative);
    }
  }

  return results;
}

function parseGitStatus(raw) {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0] && lines[0].startsWith('## ') ? lines.shift().slice(3) : '';
  const branch = branchLine.split('...')[0].trim();

  const files = lines.map(line => {
    const status = line.slice(0, 2);
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop();

    return {
      status,
      path: filePath.replace(/^"|"$/g, '')
    };
  });

  return { branch, files };
}

async function getGitStatus(projectPath) {
  const project = getProject(projectPath);

  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      project.path,
      'status',
      '--porcelain=v1',
      '--branch',
      '--untracked-files=normal'
    ], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });

    const parsed = parseGitStatus(stdout);
    return {
      available: true,
      branch: parsed.branch || 'HEAD',
      files: parsed.files,
      dirty: parsed.files.length > 0
    };
  } catch (error) {
    return {
      available: false,
      branch: '',
      files: [],
      dirty: false,
      error: error.code === 'ENOENT' ? 'Git is not installed.' : 'This folder is not a Git repository.'
    };
  }
}

async function revealPath(projectPath, relativePath = '') {
  const { target } = resolveProjectPath(projectPath, relativePath);
  const stat = await fsp.stat(target);

  if (stat.isDirectory()) {
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return true;
  }

  shell.showItemInFolder(target);
  return true;
}

async function removeProject(projectPath) {
  const project = getProject(projectPath);
  projectStore = projectStore.filter(item => item.id !== project.id);
  await saveProjectStore();
  return true;
}

async function checkBackend(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, status: 0, message: 'Enter a valid backend URL.' };
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return { ok: false, status: 0, message: 'Backend URL must use HTTP or HTTPS.' };
  }

  const healthUrl = new URL('health', url.href.endsWith('/') ? url.href : url.href + '/');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain;q=0.8, */*;q=0.5' }
    });
    clearTimeout(timeout);

    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? 'Backend reachable.' : 'Backend returned HTTP ' + response.status + '.'
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error.name === 'AbortError' ? 'Backend connection timed out.' : 'Backend is not reachable.'
    };
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#101317',
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const currentUrl = win.webContents.getURL();
    if (url === currentUrl || url.startsWith('file://')) return;

    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
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

  ipcMain.handle('june:window-minimize', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
    return true;
  });

  ipcMain.handle('june:window-toggle-maximize', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle('june:window-is-maximized', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win?.isMaximized());
  });

  ipcMain.handle('june:window-close', event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
    return true;
  });

  ipcMain.handle('june:list-projects', () => projectStore.map(project => ({ ...project })));

  ipcMain.handle('june:select-project-directory', async () => {
    const parentWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showOpenDialog(parentWindow, {
      title: 'Add project to June',
      buttonLabel: 'Add project',
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) return null;
    return addProject(result.filePaths[0]);
  });

  ipcMain.handle('june:remove-project', (_event, projectPath) => removeProject(projectPath));
  ipcMain.handle('june:list-directory', (_event, projectPath, relativePath, options) =>
    listDirectory(projectPath, relativePath, options)
  );
  ipcMain.handle('june:read-text-file', (_event, projectPath, relativePath, maxBytes) =>
    readTextFile(projectPath, relativePath, maxBytes)
  );
  ipcMain.handle('june:search-files', (_event, projectPath, query, options) =>
    searchFiles(projectPath, query, options)
  );
  ipcMain.handle('june:get-git-status', (_event, projectPath) => getGitStatus(projectPath));
  ipcMain.handle('june:check-backend', (_event, backendUrl) => checkBackend(backendUrl));
  ipcMain.handle('june:reveal-path', (_event, projectPath, relativePath) =>
    revealPath(projectPath, relativePath)
  );
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    await loadProjectStore();
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
