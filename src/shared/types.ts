/** Every vault item carries id + updatedAt so a future sync server can merge per item. */
export interface VaultItem {
  id: string;
  updatedAt: number;
}

export interface Connection extends VaultItem {
  name: string;
  host: string;
  port: number;
  username: string;
  keyId?: string;
  /** Optional password auth (used when no key is set, or as fallback). */
  password?: string;
  group?: string;
  color?: string;
}

export interface KeyEntry extends VaultItem {
  name: string;
  pem: string;
  passphrase?: string;
}

/** A saved command, inserted into a terminal from the palette (Ctrl+Shift+P). */
export interface Snippet extends VaultItem {
  name: string;
  command: string;
  /** Press Enter after inserting. */
  run: boolean;
}

export interface KnownHost extends VaultItem {
  /** "host:port" */
  hostPort: string;
  /** SHA256 fingerprint, base64 */
  fingerprint: string;
}

export interface Settings {
  autoLockMinutes: number;
  fontSize: number;
  /** Poll the active server for OS / CPU / memory / disk stats for the status bar. */
  serverStats: boolean;
  /** Terminal colour scheme id (see renderer/themes.ts). */
  theme: string;
  /** CSS font-family list for the terminal; empty = built-in default. */
  fontFamily: string;
  /** Reconnect by itself when a connection drops. */
  autoReconnect: boolean;
  /** Folder to save session logs to; empty = off. */
  logDir: string;
  /** Look for new versions on GitHub. */
  checkUpdates: boolean;
}

/** GitHub sync configuration. Device-local: never merged from the remote copy. */
export interface SyncConfig {
  /** "owner/name" of a private repository */
  repo: string;
  token: string;
  lastSyncAt?: number;
}

export type SyncState = 'off' | 'syncing' | 'ok' | 'error' | 'needs-password';

export interface SyncStatus {
  state: SyncState;
  repo?: string;
  message?: string;
  lastSyncAt?: number;
  /** The master password is short/simple; matters more once the vault is stored online. */
  weakPassword?: boolean;
}

export interface VaultData {
  connections: Connection[];
  keys: KeyEntry[];
  snippets: Snippet[];
  knownHosts: KnownHost[];
  /** Device-local, like `sync`. */
  settings: Settings;
  sync?: SyncConfig;
  /** Ids of deleted items, kept so sync can propagate deletions. */
  tombstones: VaultItem[];
  updatedAt: number;
}

/** Key metadata safe to send to the renderer (no key material). */
export interface KeyInfo {
  id: string;
  name: string;
  hasPassphrase: boolean;
  /** e.g. "ssh-ed25519 SHA256:…" */
  fingerprint?: string;
  updatedAt: number;
}

/** Connection as sent to the renderer: password replaced by a flag. */
export type ConnectionInfo = Omit<Connection, 'password'> & { hasPassword: boolean };

export type ConnectionInput = Omit<Connection, 'id' | 'updatedAt'> & { id?: string };

export type VaultState = 'missing' | 'locked' | 'unlocked';

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error';

/**
 * Why a session ended: the shell exited, it was closed from this side, authentication or the
 * host key failed, or the connection was lost (network error / unexpected close).
 */
export type EndReason = 'exit' | 'user' | 'auth' | 'hostkey' | 'lost';

export interface HostKeyPrompt {
  requestId: string;
  hostPort: string;
  fingerprint: string;
  /** Previously trusted fingerprint, if the key changed. */
  previous?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  autoLockMinutes: 15,
  fontSize: 14,
  serverStats: true,
  theme: 'terminaltab',
  fontFamily: '',
  autoReconnect: true,
  logDir: '',
  checkUpdates: true,
};

/** Remote machine stats (Linux only). Sizes are in bytes. */
export interface ServerStats {
  os?: string;
  load1?: number;
  cores?: number;
  memTotal?: number;
  memUsed?: number;
  diskTotal?: number;
  diskUsed?: number;
  uptimeSec?: number;
}

/** Live information about a connected session, pushed for the tab being viewed. */
export interface SessionInfo {
  connectedAt: number;
  bytesIn: number;
  bytesOut: number;
  latencyMs?: number;
  /** undefined = not fetched yet, null = not available (non-Linux server, or disabled). */
  server?: ServerStats | null;
}

export function emptyVault(): VaultData {
  return {
    connections: [],
    keys: [],
    snippets: [],
    knownHosts: [],
    settings: { ...DEFAULT_SETTINGS },
    tombstones: [],
    updatedAt: Date.now(),
  };
}

/** One entry in an SFTP directory listing. */
export interface RemoteEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  /** ms since epoch */
  mtime: number;
  /** Unix permission bits, e.g. 0o755 */
  mode: number;
}

export interface TransferProgress {
  id: string;
  sessionId: string;
  direction: 'up' | 'down';
  name: string;
  done: number;
  total: number;
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
}

/** A server found in ~/.ssh/config or PuTTY, offered for import. */
export interface ImportCandidate {
  id: string;
  source: 'ssh-config' | 'putty';
  name: string;
  host: string;
  port: number;
  username: string;
  /** Path of the private key file, if one is configured. */
  keyPath?: string;
  /** Problem with the key file (missing, unsupported), if any. */
  keyProblem?: string;
  /** The key file needs a passphrase. */
  keyEncrypted?: boolean;
  /** A key with the same fingerprint is already in the vault. */
  keyExisting?: string;
  /** A server with the same host, port and user is already saved. */
  exists: boolean;
  /** e.g. ProxyJump, which TerminalTab does not support yet. */
  note?: string;
}

export interface UpdateInfo {
  state: 'none' | 'available' | 'downloaded';
  version?: string;
  url?: string;
}
