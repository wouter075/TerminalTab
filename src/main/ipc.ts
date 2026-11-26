import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, net, powerMonitor, shell } from 'electron';
import { utils } from 'ssh2';
import type { AppData, ConnectionSave, PickedKeyFile, SnippetSave } from '../shared/api';
import { DEFAULT_SETTINGS, type ConnectionInfo, type ImportCandidate, type KeyEntry, type KeyInfo, type Settings, type VaultData, type VaultState } from '../shared/types';
import { GitHubClient, normalizeRepo, type FetchFn } from './github';
import { applyImports, scanImports, type ScanResult } from './importScan';
import { SessionLogger } from './sessionLog';
import { LocalShellManager } from './localShells';
import { keyFingerprint, SessionManager } from './sessions';
import { SftpManager } from './sftp';
import { Updater } from './updates';
import { SyncManager } from './sync';
import { Vault, WrongPasswordError } from './vault';

export function registerIpc(vaultFile: string, getWindow: () => BrowserWindow | null): { shutdown(): void } {
  const vault = new Vault(vaultFile);
  const send = (channel: string, ...args: unknown[]) => getWindow()?.webContents.send(channel, ...args);

  // ---- GitHub sync -----------------------------------------------------
  // Electron's net.fetch uses the system proxy settings (school / company networks).
  const fetchFn: FetchFn = (url, init) => net.fetch(url, init);
  const github = (token: string) => new GitHubClient(token, fetchFn);
  const sync = new SyncManager({
    vault,
    makeStore: (cfg) => github(cfg.token).store(cfg.repo),
    onStatus: (s) => send('sync:status', s),
    onDataChanged: () => send('data:changed'),
  });
  vault.onChange = () => sync.schedule();

  // ---- auto-lock -------------------------------------------------------
  let lockTimer: NodeJS.Timeout | null = null;
  const doLock = () => {
    if (!vault.isUnlocked) return;
    sync.stop();
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

  const logger = new SessionLogger();
  const sessions = new SessionManager({
    onData: (sid, data) => {
      logger.write(sid, data);
      send('session:data', sid, data);
    },
    onStatus: (sid, status, message, reason) => {
      if (status === 'closed' || status === 'error') {
        logger.end(sid, message);
        sftp.drop(sid);
      }
      send('session:status', sid, status, message, reason);
    },
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
          for (const old of d.knownHosts.filter((h) => h.hostPort === hostPort)) tombstone(d, old.id);
          d.knownHosts = d.knownHosts.filter((h) => h.hostPort !== hostPort);
          d.knownHosts.push({ id: randomUUID(), updatedAt: Date.now(), hostPort, fingerprint });
        });
      }
      return trust;
    },
  });

  // Local shells share the session events (and session logs) with SSH tabs.
  const local = new LocalShellManager({
    onData: (sid, data) => {
      logger.write(sid, data);
      send('session:data', sid, data);
    },
    onStatus: (sid, status, message, reason) => {
      if (status === 'closed' || status === 'error') logger.end(sid, message);
      send('session:status', sid, status, message, reason);
    },
    onInfo: (sid, info) => send('session:info', sid, info),
  });

  const sftp = new SftpManager(
    (sid) => sessions.getClient(sid),
    (p) => send('sftp:progress', p),
  );

  // ---- updates ---------------------------------------------------------
  // Remembered so update checks follow the setting while the vault is locked too.
  let checkUpdates = true;
  const updater = new Updater(
    () => checkUpdates,
    (info) => send('update:status', info),
  );
  updater.start();

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
    snippets: d.snippets,
    settings: d.settings,
    sync: d.sync ? { repo: d.sync.repo } : undefined,
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
  handle('vault:unlock', async (pw: string) => {
    await vault.unlock(pw);
    checkUpdates = vault.get().settings.checkUpdates;
    sync.start();
  }, false);
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

  handle('snippet:save', async (input: SnippetSave) => {
    const command = String(input.command ?? '').replace(/\r\n/g, '\n');
    if (!command.trim()) throw new Error('The command is empty');
    const id = input.id ?? randomUUID();
    await vault.update((d) => {
      const next = {
        id,
        updatedAt: Date.now(),
        name: String(input.name ?? '').trim() || command.split('\n')[0].slice(0, 40),
        command,
        run: !!input.run,
      };
      const existing = d.snippets.find((x) => x.id === id);
      if (existing) Object.assign(existing, next);
      else d.snippets.push(next);
    });
    return id;
  });

  // ---- import from ~/.ssh/config and PuTTY ------------------------------
  let lastScan: ScanResult | null = null;
  handle('import:scan', async (): Promise<ImportCandidate[]> => {
    lastScan = await scanImports(vault.get());
    return lastScan.candidates;
  });
  handle('import:apply', async (ids: string[], passphrases: Record<string, string>) => {
    const scan = lastScan;
    if (!scan) throw new Error('Scan again');
    let result = { connections: 0, keys: 0 };
    await vault.update((d) => {
      result = applyImports(d, scan, ids, passphrases ?? {});
    });
    lastScan = null;
    return result;
  });

  handle('snippet:delete', (id: string) =>
    vault.update((d) => {
      d.snippets = d.snippets.filter((x) => x.id !== id);
      tombstone(d, id);
    }),
  );

  handle('settings:save', (s: Partial<Settings>) =>
    vault.update((d) => {
      const cur = d.settings;
      const str = (v: unknown, fallback: string, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
      const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
      d.settings = {
        autoLockMinutes: Math.max(0, Math.min(1440, Number(s.autoLockMinutes ?? cur.autoLockMinutes) || 0)),
        fontSize: Math.max(8, Math.min(32, Number(s.fontSize ?? cur.fontSize) || DEFAULT_SETTINGS.fontSize)),
        serverStats: bool(s.serverStats, cur.serverStats),
        theme: str(s.theme, cur.theme, 40) || DEFAULT_SETTINGS.theme,
        fontFamily: str(s.fontFamily, cur.fontFamily),
        autoReconnect: bool(s.autoReconnect, cur.autoReconnect),
        logDir: str(s.logDir, cur.logDir, 1000),
        checkUpdates: bool(s.checkUpdates, cur.checkUpdates),
        defaultShell: str(s.defaultShell, cur.defaultShell, 300),
      };
      checkUpdates = d.settings.checkUpdates;
    }),
  );

  handle('settings:pickLogDir', async (): Promise<string | null> => {
    const win = getWindow();
    const opts = { title: 'Folder for session logs', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });

  handle('update:get', () => updater.current, false);
  handle('update:restart', () => updater.restart(), false);

  // ---- sync ------------------------------------------------------------
  handle('sync:status', () => sync.getStatus());

  handle('sync:connect', async (repoInput: string, tokenInput?: string) => {
    const repo = normalizeRepo(repoInput);
    const token = tokenInput?.trim() || vault.get().sync?.token;
    if (!token) throw new Error('Enter a GitHub token');
    await github(token).checkRepo(repo);
    await vault.update((d) => (d.sync = { repo, token }), { silent: true });
    sync.start();
    return sync.syncNow();
  });

  handle('sync:disconnect', async () => {
    sync.stop();
    await vault.update((d) => (d.sync = undefined), { silent: true });
    send('sync:status', sync.getStatus());
  });

  handle('sync:now', (password?: string) => sync.syncNow(password || undefined));

  handle('sync:restore', async (repoInput: string, token: string, password: string) => {
    const repo = normalizeRepo(repoInput);
    const client = github(token.trim());
    await client.checkRepo(repo);
    const remote = await client.store(repo).get();
    if (!remote) throw new Error(`No TerminalTab vault in ${repo} yet. Turn on sync on your other PC first.`);
    try {
      await vault.restore(remote.blob, password, (d) => (d.sync = { repo, token: token.trim(), lastSyncAt: Date.now() }));
    } catch (err) {
      if (err instanceof WrongPasswordError) throw new Error('Wrong master password for the vault on GitHub');
      throw err;
    }
    sync.start();
  }, false);

  // ---- sessions --------------------------------------------------------
  handle('session:open', (connectionId: string, cols: number, rows: number) => {
    const d = vault.get();
    const conn = d.connections.find((c) => c.id === connectionId);
    if (!conn) throw new Error('Connection not found');
    const key = conn.keyId ? d.keys.find((k) => k.id === conn.keyId) : undefined;
    const sid = sessions.open(conn, key, cols, rows);
    logger.start(sid, d.settings.logDir, conn.name, `${conn.username}@${conn.host}:${conn.port}`);
    return sid;
  });

  handle('local:list', (fresh?: boolean) => local.list(!!fresh));
  handle('local:open', async (shellId: string, cols: number, rows: number) => {
    const { sessionId, shell } = await local.open(String(shellId), Number(cols) || 80, Number(rows) || 24);
    logger.start(sessionId, vault.get().settings.logDir, `Local - ${shell.name}`, `${shell.name} on this PC`);
    return sessionId;
  });

  // ---- SFTP ------------------------------------------------------------
  handle('sftp:list', (sid: string, dir: string) => sftp.list(sid, dir));
  handle('sftp:mkdir', (sid: string, p: string) => sftp.mkdir(sid, p));
  handle('sftp:rename', (sid: string, from: string, to: string) => sftp.rename(sid, from, to));
  handle('sftp:remove', (sid: string, p: string) => sftp.remove(sid, p));
  handle('sftp:cancel', (id: string) => sftp.cancel(id));
  handle('sftp:upload', (sid: string, localPaths: string[], remoteDir: string) =>
    sftp.upload(sid, localPaths.filter((p) => typeof p === 'string' && path.isAbsolute(p)), remoteDir),
  );
  handle('sftp:uploadPick', async (sid: string, remoteDir: string) => {
    const win = getWindow();
    const opts = { title: 'Upload files', properties: ['openFile' as const, 'multiSelections' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return false;
    await sftp.upload(sid, res.filePaths, remoteDir);
    return true;
  });
  /** Ask where to save, then download. Returns the local path (for "Show in folder"), or null if cancelled. */
  handle('sftp:download', async (sid: string, remotePaths: string[], isFile: boolean) => {
    const win = getWindow();
    if (remotePaths.length === 1 && isFile) {
      const name = path.posix.basename(remotePaths[0]);
      const opts = { title: 'Download', defaultPath: name };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return null;
      await sftp.download(sid, remotePaths, path.dirname(res.filePath), path.basename(res.filePath));
      return res.filePath;
    }
    const opts = { title: 'Download to folder', properties: ['openDirectory' as const, 'createDirectory' as const] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) return null;
    await sftp.download(sid, remotePaths, res.filePaths[0]);
    return remotePaths.length === 1 ? path.join(res.filePaths[0], path.posix.basename(remotePaths[0])) : res.filePaths[0];
  });
  handle('shell:showItem', (p: string) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
  });

  ipcMain.on('session:write', (_e, sid: string, data: string) => {
    if (!vault.isUnlocked) return; // no typing into sessions behind the lock screen
    if (local.has(sid)) local.write(sid, data);
    else sessions.write(sid, data);
    touch();
  });
  ipcMain.on('session:resize', (_e, sid: string, cols: number, rows: number) =>
    local.has(sid) ? local.resize(sid, cols, rows) : sessions.resize(sid, cols, rows),
  );
  ipcMain.on('session:close', (_e, sid: string) => (local.has(sid) ? local.close(sid) : sessions.close(sid)));
  ipcMain.on('session:watch', (_e, sid: string | null) => {
    const isLocal = !!sid && local.has(sid);
    sessions.watch(isLocal ? null : sid);
    local.watch(isLocal ? sid : null);
  });
  ipcMain.on('hostkey:answer', (_e, requestId: string, trust: boolean) => {
    hostKeyWaiters.get(requestId)?.(trust);
    hostKeyWaiters.delete(requestId);
  });

  return {
    shutdown() {
      sync.stop();
      updater.stop();
      sessions.closeAll();
      local.closeAll();
      logger.endAll();
      vault.lock();
    },
  };
}
