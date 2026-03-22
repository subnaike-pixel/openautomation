const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('splash', {
  onLog: (cb) => {
    ipcRenderer.removeAllListeners('splash:log');
    ipcRenderer.on('splash:log', (_, m) => cb(m));
  },
  onDone: (cb) => {
    ipcRenderer.removeAllListeners('splash:done');
    ipcRenderer.on('splash:done', () => cb());
  },
  onError: (cb) => {
    ipcRenderer.removeAllListeners('splash:error');
    ipcRenderer.on('splash:error', (_, e) => cb(e));
  },
  ready: () => ipcRenderer.send('splash:ready'),
});
