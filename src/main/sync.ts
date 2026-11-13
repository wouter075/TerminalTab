import type { SyncConfig, SyncStatus } from '../shared/types';
import { ConflictError, type RemoteStore } from './github';
import { mergeVaults, sameSyncedContent } from './merge';
import { PasswordChangedError, WrongPasswordError, type Vault } from './vault';

const DEBOUNCE_MS = 1500;
const PERIODIC_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;

export interface SyncDeps {
  vault: Vault;
  makeStore(cfg: SyncConfig): RemoteStore;
  onStatus(status: SyncStatus): void;
  /** The local data changed because of incoming changes; the UI should reload. */
  onDataChanged(): void;
}

/**
 * Pull → merge → push of the encrypted vault. Runs are serialized; a change during a run
 * triggers one more run afterwards.
 */
export class SyncManager {
  private status: SyncStatus = { state: 'off' };
  private running: Promise<void> | null = null;
  private rerun = false;
  private debounce: NodeJS.Timeout | null = null;
  private periodic: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SyncDeps) {}

  getStatus(): SyncStatus {
    const { vault } = this.deps;
    const cfg = vault.isUnlocked ? vault.get().sync : undefined;
    if (!cfg) return { state: 'off' };
    return { ...this.status, repo: cfg.repo, lastSyncAt: cfg.lastSyncAt, weakPassword: vault.passwordWeak };
  }

  /** Call after unlocking. */
  start(): void {
    this.stop();
    this.periodic = setInterval(() => this.schedule(0), PERIODIC_MS);
    this.schedule(0);
  }

  /** Call when locking. */
  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    if (this.periodic) clearInterval(this.periodic);
    this.debounce = this.periodic = null;
    this.status = { state: 'off' };
  }

  schedule(delay = DEBOUNCE_MS): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.syncNow().catch(() => undefined);
    }, delay);
  }

  /** Sync now. `password` answers a 'needs-password' state (master password changed elsewhere). */
  async syncNow(password?: string): Promise<SyncStatus> {
    if (this.running) {
      this.rerun = true;
      await this.running;
      if (!password) return this.getStatus();
    }
    this.running = this.run(password).finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.rerun) {
      this.rerun = false;
      await this.syncNow();
    }
    return this.getStatus();
  }

  private setStatus(s: Omit<SyncStatus, 'repo' | 'lastSyncAt' | 'weakPassword'>) {
    this.status = s;
    this.deps.onStatus(this.getStatus());
  }

  private async run(password?: string): Promise<void> {
    const { vault } = this.deps;
    if (!vault.isUnlocked) return;
    const cfg = vault.get().sync;
    if (!cfg) return this.setStatus({ state: 'off' });
    // Waiting for the user's password: only a run that brings one can continue.
    if (this.status.state === 'needs-password' && !password) return this.setStatus(this.status);

    this.setStatus({ state: 'syncing' });
    const store = this.deps.makeStore(cfg);
    try {
      for (let attempt = 1; ; attempt++) {
        const current = await store.get();
        if (!current) {
          await store.put(vault.exportBlob(), undefined);
          break;
        }

        let remote = null;
        try {
          remote = vault.decryptBlob(current.blob);
        } catch (err) {
          if (!(err instanceof PasswordChangedError)) throw err;
        }
        if (!remote) {
          if (!password) {
            return this.setStatus({
              state: 'needs-password',
              message: 'The vault on GitHub uses a different master password (changed on another device).',
            });
          }
          // Adopts that password for this device too.
          remote = await vault.adoptKeyOf(current.blob, password);
        }

        const local = vault.get();
        const merged = mergeVaults(local, remote);
        if (!sameSyncedContent(merged, local)) {
          await vault.update((d) => Object.assign(d, merged), { silent: true });
          this.deps.onDataChanged();
        }

        if (sameSyncedContent(merged, remote) && vault.usesCurrentKey(current.blob)) break;
        try {
          await store.put(vault.exportBlob(), current.sha);
          break;
        } catch (err) {
          if (err instanceof ConflictError && attempt < MAX_ATTEMPTS) continue; // someone else pushed: merge again
          throw err;
        }
      }
      await vault.update((d) => d.sync && (d.sync.lastSyncAt = Date.now()), { silent: true });
      this.setStatus({ state: 'ok' });
    } catch (err) {
      if (err instanceof WrongPasswordError && password) {
        return this.setStatus({ state: 'needs-password', message: 'That password did not unlock the vault on GitHub.' });
      }
      this.setStatus({ state: 'error', message: (err as Error).message });
    }
  }
}
