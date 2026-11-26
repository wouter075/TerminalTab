import type {
  ConnectionInfo,
  ConnectionInput,
  HostKeyPrompt,
  ImportCandidate,
  UpdateCheck,
  EndReason,
  KeyInfo,
  LocalShell,
  RemoteEntry,
  SessionInfo,
  Snippet,
  SessionStatus,
  Settings,
  SyncStatus,
  TransferProgress,
  UpdateInfo,
  VaultState,
} from './types';

export interface AppData {
  connections: ConnectionInfo[];
  keys: KeyInfo[];
  snippets: Snippet[];
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

export type SnippetSave = Pick<Snippet, 'name' | 'command' | 'run'> & { id?: string };

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
  /** Partial: omitted fields keep their value. */
  saveSettings(settings: Partial<Settings>): Promise<void>;
  saveSnippet(snippet: SnippetSave): Promise<string>;
  /** Find servers in ~/.ssh/config and PuTTY. */
  scanImports(): Promise<ImportCandidate[]>;
  /** Import the chosen candidates; passphrases are keyed by key path. */
  applyImports(ids: string[], passphrases: Record<string, string>): Promise<{ connections: number; keys: number }>;
  deleteSnippet(id: string): Promise<void>;
  /** Folder picker for session logs; null if cancelled. */
  pickLogDir(): Promise<string | null>;

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
  /** Shells installed on this PC; `fresh` detects them again. */
  localShells(fresh?: boolean): Promise<LocalShell[]>;
  /** Start a local shell; uses the same write/resize/close/events as SSH sessions. */
  openLocal(shellId: string, cols: number, rows: number): Promise<string>;

  sftpList(sessionId: string, dir: string): Promise<{ path: string; entries: RemoteEntry[] }>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpRemove(sessionId: string, path: string): Promise<void>;
  /** Upload local paths (e.g. dropped files) into a remote folder. */
  sftpUpload(sessionId: string, localPaths: string[], remoteDir: string): Promise<void>;
  /** Pick files to upload; false if cancelled. */
  sftpUploadPick(sessionId: string, remoteDir: string): Promise<boolean>;
  /** Ask where to save, then download; returns the local path or null if cancelled. */
  sftpDownload(sessionId: string, remotePaths: string[], isFile: boolean): Promise<string | null>;
  sftpCancel(transferId: string): Promise<void>;
  /** Local path of a file dropped onto the window. */
  pathForFile(file: File): string;
  showItemInFolder(path: string): Promise<void>;

  updateStatus(): Promise<UpdateInfo>;
  restartToUpdate(): Promise<void>;
  /** Check for a new version right now (also when automatic checks are off). */
  checkForUpdates(): Promise<UpdateCheck>;

  onSessionData(cb: (sessionId: string, data: Uint8Array) => void): () => void;
  onSessionStatus(
    cb: (sessionId: string, status: SessionStatus, message?: string, reason?: EndReason) => void,
  ): () => void;
  onSessionInfo(cb: (sessionId: string, info: SessionInfo) => void): () => void;
  onHostKeyPrompt(cb: (prompt: HostKeyPrompt) => void): () => void;
  onLocked(cb: () => void): () => void;
  onSyncStatus(cb: (status: SyncStatus) => void): () => void;
  onDataChanged(cb: () => void): () => void;
  onTransfer(cb: (p: TransferProgress) => void): () => void;
  onUpdate(cb: (info: UpdateInfo) => void): () => void;
}

declare global {
  interface Window {
    terminalTab: TerminalTabApi;
  }
}
