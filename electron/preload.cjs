const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = Object.freeze({
  isDesktop: true,
  getRuntimeInfo: () => ipcRenderer.invoke('june:get-runtime-info'),
  selectProjectDirectory: () => ipcRenderer.invoke('june:select-project-directory')
});

contextBridge.exposeInMainWorld('juneDesktop', desktopApi);
