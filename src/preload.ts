import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
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
  saveSnippet: (s) => ipcRenderer.invoke('snippet:save', s),
  deleteSnippet: (id) => ipcRenderer.invoke('snippet:delete', id),
  scanImports: () => ipcRenderer.invoke('import:scan'),
  applyImports: (ids, passphrases) => ipcRenderer.invoke('import:apply', ids, passphrases),
  pickLogDir: () => ipcRenderer.invoke('settings:pickLogDir'),

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
  localShells: (fresh) => ipcRenderer.invoke('local:list', fresh),
  openLocal: (shellId, cols, rows) => ipcRenderer.invoke('local:open', shellId, cols, rows),

  sftpList: (sid, dir) => ipcRenderer.invoke('sftp:list', sid, dir),
  sftpMkdir: (sid, p) => ipcRenderer.invoke('sftp:mkdir', sid, p),
  sftpRename: (sid, from, to) => ipcRenderer.invoke('sftp:rename', sid, from, to),
  sftpRemove: (sid, p) => ipcRenderer.invoke('sftp:remove', sid, p),
  sftpUpload: (sid, paths, dir) => ipcRenderer.invoke('sftp:upload', sid, paths, dir),
  sftpUploadPick: (sid, dir) => ipcRenderer.invoke('sftp:uploadPick', sid, dir),
  sftpDownload: (sid, paths, isFile) => ipcRenderer.invoke('sftp:download', sid, paths, isFile),
  sftpCancel: (id) => ipcRenderer.invoke('sftp:cancel', id),
  pathForFile: (file) => webUtils.getPathForFile(file),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),

  updateStatus: () => ipcRenderer.invoke('update:get'),
  restartToUpdate: () => ipcRenderer.invoke('update:restart'),

  onSessionData: (cb) => listen('session:data', cb),
  onSessionStatus: (cb) => listen('session:status', cb),
  onSessionInfo: (cb) => listen('session:info', cb),
  onHostKeyPrompt: (cb) => listen('hostkey:prompt', cb),
  onLocked: (cb) => listen('vault:locked', cb),
  onSyncStatus: (cb) => listen('sync:status', cb),
  onDataChanged: (cb) => listen('data:changed', cb),
  onTransfer: (cb) => listen('sftp:progress', cb),
  onUpdate: (cb) => listen('update:status', cb),
};

contextBridge.exposeInMainWorld('terminalTab', api);
