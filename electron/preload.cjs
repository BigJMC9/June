const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = Object.freeze({
  isDesktop: true,
  getRuntimeInfo: () => ipcRenderer.invoke('june:get-runtime-info'),
  listProjects: () => ipcRenderer.invoke('june:list-projects'),
  selectProjectDirectory: () => ipcRenderer.invoke('june:select-project-directory'),
  removeProject: projectPath => ipcRenderer.invoke('june:remove-project', projectPath),
  listDirectory: (projectPath, relativePath = '', options = {}) =>
    ipcRenderer.invoke('june:list-directory', projectPath, relativePath, options),
  readTextFile: (projectPath, relativePath, maxBytes) =>
    ipcRenderer.invoke('june:read-text-file', projectPath, relativePath, maxBytes),
  searchFiles: (projectPath, query, options = {}) =>
    ipcRenderer.invoke('june:search-files', projectPath, query, options),
  getGitStatus: projectPath => ipcRenderer.invoke('june:get-git-status', projectPath),
  checkBackend: backendUrl => ipcRenderer.invoke('june:check-backend', backendUrl),
  revealPath: (projectPath, relativePath = '') =>
    ipcRenderer.invoke('june:reveal-path', projectPath, relativePath)
});

contextBridge.exposeInMainWorld('juneDesktop', desktopApi);
