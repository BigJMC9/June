const { contextBridge, ipcRenderer } = require('electron');
const desktopApi = Object.freeze({
  isDesktop: true,
  backendCall: (action, data = {}) => ipcRenderer.invoke('june:backend', { action, data }),
  onBackendEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('june:backend-event', listener);
    return () => ipcRenderer.removeListener('june:backend-event', listener);
  },
  getRuntimeInfo: () => ipcRenderer.invoke('june:get-runtime-info'),
  minimizeWindow: () => ipcRenderer.invoke('june:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('june:window-toggle-maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('june:window-is-maximized'),
  closeWindow: () => ipcRenderer.invoke('june:window-close'),
  listProjects: () => ipcRenderer.invoke('june:list-projects'),
  selectProjectDirectory: () => ipcRenderer.invoke('june:select-project-directory'),
  removeProject: projectPath => ipcRenderer.invoke('june:remove-project', projectPath),
  listDirectory: (projectPath, relativePath = '', options = {}) => ipcRenderer.invoke('june:list-directory', projectPath, relativePath, options),
  readTextFile: (projectPath, relativePath, maxBytes) => ipcRenderer.invoke('june:read-text-file', projectPath, relativePath, maxBytes),
  searchFiles: (projectPath, query, options = {}) => ipcRenderer.invoke('june:search-files', projectPath, query, options),
  getGitStatus: projectPath => ipcRenderer.invoke('june:get-git-status', projectPath),
  checkBackend: backendUrl => ipcRenderer.invoke('june:check-backend', backendUrl),
  revealPath: (projectPath, relativePath = '') => ipcRenderer.invoke('june:reveal-path', projectPath, relativePath),
  copyText: text => ipcRenderer.invoke('june:copy-text', text),
  saveArtifact: payload => ipcRenderer.invoke('june:save-artifact', payload),
  getCookbookInfo: () => ipcRenderer.invoke('june:cookbook-info'),
  chooseModelFolder: () => ipcRenderer.invoke('june:choose-model-folder'),
  scanModels: () => ipcRenderer.invoke('june:scan-models'),
  inspectEnvironment: () => ipcRenderer.invoke('june:inspect-environment'),
  fetchSkill: url => ipcRenderer.invoke('june:fetch-skill', url),
  openModelPage: repo => ipcRenderer.invoke('june:open-model-page', repo)
});
contextBridge.exposeInMainWorld('juneDesktop', desktopApi);
