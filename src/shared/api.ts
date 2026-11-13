import type {
  ConnectionInfo,
  ConnectionInput,
  HostKeyPrompt,
  KeyInfo,
  SessionInfo,
  SessionStatus,
  Settings,
  SyncStatus,
  VaultState,
} from './types';

export interface AppData {
  connections: ConnectionInfo[];
  keys: KeyInfo[];
  settings: Settings;
  /** Present when GitHub sync is set up (the token is never sent to the renderer). */
  sync?: { repo: string };
}

export interface PickedKeyFile {
  token: string;
  fileName: string;
  /** True if the key needs a passphrase. */
  encrypted: boolean;
}

/**
 * Connection save payload. `password`: undefined = keep existing, '' = remove, string = set.
 */
export type ConnectionSave = Omit<ConnectionInput, 'password'> & { password?: string };

/** API exposed to the renderer as window.terminalTab. */
export interface TerminalTabApi {
  vaultState(): Promise<VaultState>;
  createVault(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  changePassword(oldPassword: string, newPassword: string): Promise<void>;

  getData(): Promise<AppData>;
  saveConnection(conn: ConnectionSave): Promise<string>;
  deleteConnection(id: string): Promise<void>;
  pickKeyFile(): Promise<PickedKeyFile | null>;
  addKey(token: string, name: string, passphrase?: string): Promise<KeyInfo>;
  renameKey(id: string, name: string): Promise<void>;
  deleteKey(id: string): Promise<void>;
  saveSettings(settings: Settings): Promise<void>;

  syncStatus(): Promise<SyncStatus>;
  /** Check the repo + token, save them and sync. Omit the token to keep the saved one. */
  syncConnect(repo: string, token?: string): Promise<SyncStatus>;
  syncDisconnect(): Promise<void>;
  /** `password` answers the 'needs-password' state. */
  syncNow(password?: string): Promise<SyncStatus>;
  /** New device: download the vault from GitHub and unlock it. */
  syncRestore(repo: string, token: string, password: string): Promise<void>;

  openSession(connectionId: string, cols: number, rows: number): Promise<string>;
  write(sessionId: string, data: string): void;
  resize(sessionId: string, cols: number, rows: number): void;
  closeSession(sessionId: string): void;
  /** Receive live SessionInfo for this session (the visible tab); null stops. */
  watchSession(sessionId: string | null): void;
  answerHostKey(requestId: string, trust: boolean): void;

  onSessionData(cb: (sessionId: string, data: Uint8Array) => void): () => void;
  onSessionStatus(cb: (sessionId: string, status: SessionStatus, message?: string) => void): () => void;
  onSessionInfo(cb: (sessionId: string, info: SessionInfo) => void): () => void;
  onHostKeyPrompt(cb: (prompt: HostKeyPrompt) => void): () => void;
  onLocked(cb: () => void): () => void;
  onSyncStatus(cb: (status: SyncStatus) => void): () => void;
  onDataChanged(cb: () => void): () => void;
}

declare global {
  interface Window {
    terminalTab: TerminalTabApi;
  }
}
