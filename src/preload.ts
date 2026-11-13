import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { TerminalTabApi } from './shared/api';

function listen<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: TerminalTabApi = {
  vaultState: () => ipcRenderer.invoke('vault:state'),
  createVault: (pw) => ipcRenderer.invoke('vault:create', pw),
  unlock: (pw) => ipcRenderer.invoke('vault:unlock', pw),
  lock: () => ipcRenderer.invoke('vault:lock'),
  changePassword: (o, n) => ipcRenderer.invoke('vault:changePassword', o, n),

  getData: () => ipcRenderer.invoke('data:get'),
  saveConnection: (c) => ipcRenderer.invoke('conn:save', c),
  deleteConnection: (id) => ipcRenderer.invoke('conn:delete', id),
  pickKeyFile: () => ipcRenderer.invoke('key:pick'),
  addKey: (token, name, passphrase) => ipcRenderer.invoke('key:add', token, name, passphrase),
  renameKey: (id, name) => ipcRenderer.invoke('key:rename', id, name),
  deleteKey: (id) => ipcRenderer.invoke('key:delete', id),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncConnect: (repo, token) => ipcRenderer.invoke('sync:connect', repo, token),
  syncDisconnect: () => ipcRenderer.invoke('sync:disconnect'),
  syncNow: (pw) => ipcRenderer.invoke('sync:now', pw),
  syncRestore: (repo, token, pw) => ipcRenderer.invoke('sync:restore', repo, token, pw),

  openSession: (id, cols, rows) => ipcRenderer.invoke('session:open', id, cols, rows),
  write: (sid, data) => ipcRenderer.send('session:write', sid, data),
  resize: (sid, cols, rows) => ipcRenderer.send('session:resize', sid, cols, rows),
  closeSession: (sid) => ipcRenderer.send('session:close', sid),
  watchSession: (sid) => ipcRenderer.send('session:watch', sid),
  answerHostKey: (rid, trust) => ipcRenderer.send('hostkey:answer', rid, trust),

  onSessionData: (cb) => listen('session:data', cb),
  onSessionStatus: (cb) => listen('session:status', cb),
  onSessionInfo: (cb) => listen('session:info', cb),
  onHostKeyPrompt: (cb) => listen('hostkey:prompt', cb),
  onLocked: (cb) => listen('vault:locked', cb),
  onSyncStatus: (cb) => listen('sync:status', cb),
  onDataChanged: (cb) => listen('data:changed', cb),
};

contextBridge.exposeInMainWorld('terminalTab', api);
