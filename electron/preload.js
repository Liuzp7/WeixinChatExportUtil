const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('exporter', {
  pickDirectory: (options) => ipcRenderer.invoke('pick-directory', options),
  pickFile: (options) => ipcRenderer.invoke('pick-file', options),
  validateWxDir: (payload) => ipcRenderer.invoke('validate-wx-dir', payload),
  checkWeChatStatus: (payload) => ipcRenderer.invoke('check-wechat-status', payload),
  startExport: (options) => ipcRenderer.invoke('start-export', options),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('export-progress', listener);
    return () => ipcRenderer.removeListener('export-progress', listener);
  },
});
