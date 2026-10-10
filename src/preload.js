const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopMedia', {
  snapshot: () => ipcRenderer.invoke('media:snapshot'),
  command: (action) => ipcRenderer.invoke('media:command', action),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
  togglePin: () => ipcRenderer.invoke('window:toggle-pin'),
  widgetState: () => ipcRenderer.invoke('window:widget-state'),
  seek: (seconds) => ipcRenderer.invoke('media:seek', Number(seconds)),
  // click-through + dragging (new)
  setIgnoreMouse: (ignore) => ipcRenderer.send('window:set-ignore-mouse', Boolean(ignore)),
  dragBy: (dx, dy) => ipcRenderer.send('window:drag-by', Number(dx) || 0, Number(dy) || 0),
});