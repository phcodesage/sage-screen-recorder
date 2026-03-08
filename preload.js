const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderAPI', {
  listSources() {
    return ipcRenderer.invoke('sources:list');
  },
  saveRecording(arrayBuffer, defaultName) {
    return ipcRenderer.invoke('recording:save', { arrayBuffer, defaultName });
  }
});
