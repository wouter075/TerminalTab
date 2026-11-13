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
}

export interface VaultData {
  connections: Connection[];
  keys: KeyEntry[];
  knownHosts: KnownHost[];
  settings: Settings;
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

export interface HostKeyPrompt {
  requestId: string;
  hostPort: string;
  fingerprint: string;
  /** Previously trusted fingerprint, if the key changed. */
  previous?: string;
}

export const DEFAULT_SETTINGS: Settings = { autoLockMinutes: 15, fontSize: 14, serverStats: true };

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
    knownHosts: [],
    settings: { ...DEFAULT_SETTINGS },
    tombstones: [],
    updatedAt: Date.now(),
  };
}
