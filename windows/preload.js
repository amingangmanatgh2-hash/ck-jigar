'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** The only door between the page and the system: a short, explicit list of calls. */
contextBridge.exposeInMainWorld('zeus', {
  getState: () => ipcRenderer.invoke('state:get'),
  addLink: (link) => ipcRenderer.invoke('config:add', link),
  removeConfig: (id) => ipcRenderer.invoke('config:remove', id),
  fetchSubscription: (url) => ipcRenderer.invoke('subscription:fetch', url),
  start: (id) => ipcRenderer.invoke('tunnel:start', id),
  stop: () => ipcRenderer.invoke('tunnel:stop'),
  ping: (id) => ipcRenderer.invoke('core:ping', id),
  log: () => ipcRenderer.invoke('log:get'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  onState: (handler) => ipcRenderer.on('event:state', (_event, state) => handler(state)),
  onLog: (handler) => ipcRenderer.on('event:log', (_event, line) => handler(line)),
});
