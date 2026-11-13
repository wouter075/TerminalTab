import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron';
import { utils } from 'ssh2';
import type { AppData, ConnectionSave, PickedKeyFile } from '../shared/api';
import type { ConnectionInfo, KeyEntry, KeyInfo, Settings, VaultData, VaultState } from '../shared/types';
import { keyFingerprint, SessionManager } from './sessions';
import { Vault } from './vault';

export function registerIpc(vaultFile: string, getWindow: () => BrowserWindow | null): { shutdown(): void } {
  const vault = new Vault(vaultFile);
  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);

  // ---- auto-lock -------------------------------------------------------
  let lockTimer: NodeJS.Timeout | null = null;
  const doLock = () => {
    if (!vault.isUnlocked) return;
    vault.lock();
    pendingKeys.clear();
    send('vault:locked');
  };
  const touch = () => {
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = null;
    if (!vault.isUnlocked) return;
    const minutes = vault.get().settings.autoLockMinutes;
    if (minutes > 0) lockTimer = setTimeout(doLock, minutes * 60_000);
  };
  powerMonitor.on('lock-screen', doLock);
  powerMonitor.on('suspend', doLock);

  // ---- host key prompts ------------------------------------------------
  const hostKeyWaiters = new Map<string, (trust: boolean) => void>();

  const sessions = new SessionManager({
    onData: (sid, data) => send('session:data', sid, data),
    onStatus: (sid, status, message) => send('session:status', sid, status, message),
    onInfo: (sid, info) => send('session:info', sid, info),
    serverStatsEnabled: () => vault.isUnlocked && vault.get().settings.serverStats,
    verifyHostKey: async (hostPort, fingerprint) => {
      if (!vault.isUnlocked) return false;
      const known = vault.get().knownHosts.find((h) => h.hostPort === hostPort);
      if (known?.fingerprint === fingerprint) return true;
      const requestId = randomUUID();
      const trust = await new Promise<boolean>((resolve) => {
        hostKeyWaiters.set(requestId, resolve);
        send('hostkey:prompt', { requestId, hostPort, fingerprint, previous: known?.fingerprint });
      });
      if (trust && vault.isUnlocked) {
        await vault.update((d) => {
          d.knownHosts = d.knownHosts.filter((h) => h.hostPort !== hostPort);
          d.knownHosts.push({ id: randomUUID(), updatedAt: Date.now(), hostPort, fingerprint });
        });
      }
      return trust;
    },
  });

  // ---- helpers ---------------------------------------------------------
  /** Picked-but-not-yet-saved key files, so key material never travels to the renderer. */
  const pendingKeys = new Map<string, string>();

  const keyInfo = (k: KeyEntry): KeyInfo => {
    const fp = keyFingerprint(k.pem, k.passphrase);
    return {
      id: k.id,
      name: k.name,
      hasPassphrase: !!k.passphrase,
      fingerprint: fp ? `${fp.type} ${fp.fingerprint}` : undefined,
      updatedAt: k.updatedAt,
    };
  };

  const toAppData = (d: VaultData): AppData => ({
    connections: d.connections.map(({ password, ...c }): ConnectionInfo => ({ ...c, hasPassword: !!password })),
    keys: d.keys.map(keyInfo),
    settings: d.settings,
  });

  const tombstone = (d: VaultData, id: string) => d.tombstones.push({ id, updatedAt: Date.now() });

  /** Register an invoke handler that requires an unlocked vault and resets the auto-lock timer. */
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>, needsUnlock = true) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      if (needsUnlock && !vault.isUnlocked) throw new Error('Vault is locked');
      const result = await fn(...(args as A));
      touch();
      return result;
    });

  // ---- vault -----------------------------------------------------------
  handle('vault:state', async (): Promise<VaultState> => {
    if (vault.isUnlocked) return 'unlocked';
    return (await vault.exists()) ? 'locked' : 'missing';
  }, false);
  handle('vault:create', (pw: string) => vault.create(pw), false);
  handle('vault:unlock', (pw: string) => vault.unlock(pw), false);
  handle('vault:lock', () => doLock(), false);
  handle('vault:changePassword', (o: string, n: string) => vault.changePassword(o, n));

  // ---- data ------------------------------------------------------------
  handle('data:get', () => toAppData(vault.get()));

  handle('conn:save', async (input: ConnectionSave) => {
    const host = input.host?.trim();
    const username = input.username?.trim();
    const port = Number(input.port) || 22;
    if (!host) throw new Error('Host is required');
    if (!username) throw new Error('Username is required');
    if (port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    const id = input.id ?? randomUUID();
    await vault.update((d) => {
      const existing = d.connections.find((c) => c.id === id);
      const password =
        input.password === undefined ? existing?.password : input.password === '' ? undefined : input.password;
      const next = {
        id,
        updatedAt: Date.now(),
        name: input.name?.trim() || `${username}@${host}`,
        host,
        port,
        username,
        keyId: input.keyId || undefined,
        password,
        group: input.group?.trim() || undefined,
        color: input.color || undefined,
      };
      if (existing) Object.assign(existing, next);
      else d.connections.push(next);
    });
    return id;
  });

  handle('conn:delete', (id: string) =>
    vault.update((d) => {
      d.connections = d.connections.filter((c) => c.id !== id);
      tombstone(d, id);
    }),
  );

  handle('key:pick', async (): Promise<PickedKeyFile | null> => {
    const win = getWindow();
    const opts = {
      title: 'Import private key',
      properties: ['openFile' as const],
      filters: [
        { name: 'Private keys', extensions: ['pem', 'key', 'ppk', ''] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];
    const stat = await fs.stat(file);
    if (stat.size > 64 * 1024) throw new Error('That file is too large to be a private key');
    const pem = await fs.readFile(file, 'utf8');
    const parsed = utils.parseKey(pem);
    let encrypted = false;
    if (parsed instanceof Error) {
      if (/encrypted|passphrase/i.test(parsed.message)) encrypted = true;
      else throw new Error(`Not a valid private key: ${parsed.message}`);
    } else {
      const key = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!key.isPrivateKey()) throw new Error('That is a public key — select the private key file');
    }
    const token = randomUUID();
    pendingKeys.set(token, pem);
    return { token, fileName: path.basename(file), encrypted };
  });

  handle('key:add', async (token: string, name: string, passphrase?: string): Promise<KeyInfo> => {
    const pem = pendingKeys.get(token);
    if (!pem) throw new Error('Key import expired — pick the file again');
    const parsed = utils.parseKey(pem, passphrase || undefined);
    if (parsed instanceof Error) throw new Error(passphrase ? 'Wrong passphrase for this key' : parsed.message);
    pendingKeys.delete(token);
    const entry = { id: randomUUID(), updatedAt: Date.now(), name: name.trim() || 'Key', pem, passphrase: passphrase || undefined };
    await vault.update((d) => d.keys.push(entry));
    return keyInfo(entry);
  });

  handle('key:rename', (id: string, name: string) =>
    vault.update((d) => {
      const k = d.keys.find((x) => x.id === id);
      if (k && name.trim()) {
        k.name = name.trim();
        k.updatedAt = Date.now();
      }
    }),
  );

  handle('key:delete', (id: string) =>
    vault.update((d) => {
      d.keys = d.keys.filter((k) => k.id !== id);
      for (const c of d.connections) {
        if (c.keyId === id) {
          c.keyId = undefined;
          c.updatedAt = Date.now();
        }
      }
      tombstone(d, id);
    }),
  );

  handle('settings:save', (s: Settings) =>
    vault.update((d) => {
      d.settings = {
        autoLockMinutes: Math.max(0, Math.min(1440, Number(s.autoLockMinutes) || 0)),
        fontSize: Math.max(8, Math.min(32, Number(s.fontSize) || 14)),
        serverStats: s.serverStats !== false,
      };
    }),
  );

  // ---- sessions --------------------------------------------------------
  handle('session:open', (connectionId: string, cols: number, rows: number) => {
    const d = vault.get();
    const conn = d.connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('Connection not found');
    const key = conn.keyId ? d.keys.find((k) => k.id === conn.keyId) : undefined;
    return sessions.open(conn, key, cols, rows);
  });

  ipcMain.on('session:write', (_e, sid: string, data: string) => {
    if (!vault.isUnlocked) return; // no typing into sessions behind the lock screen
    sessions.write(sid, data);
    touch();
  });
  ipcMain.on('session:resize', (_e, sid: string, cols: number, rows: number) => sessions.resize(sid, cols, rows));
  ipcMain.on('session:close', (_e, sid: string) => sessions.close(sid));
  ipcMain.on('session:watch', (_e, sid: string | null) => sessions.watch(sid));
  ipcMain.on('hostkey:answer', (_e, requestId: string, trust: boolean) => {
    hostKeyWaiters.get(requestId)?.(trust);
    hostKeyWaiters.delete(requestId);
  });

  return {
    shutdown() {
      sessions.closeAll();
      vault.lock();
    },
  };
}
