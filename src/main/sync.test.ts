import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Connection, SyncStatus } from '../shared/types';
import { ConflictError, type RemoteStore } from './github';
import { SyncManager } from './sync';
import { Vault, type EncryptedVault } from './vault';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

/** In-memory stand-in for the GitHub repo file, with the same sha-based conflict rules. */
class FakeRepo {
  file: { blob: EncryptedVault; sha: string } | null = null;
  private n = 0;
  puts = 0;
  /** Simulate another device pushing right before our next put. */
  interfereOnce: (() => void) | null = null;

  store(): RemoteStore {
    return {
      get: async () => (this.file ? structuredClone(this.file) : null),
      put: async (blob, sha) => {
        if (this.interfereOnce) {
          const f = this.interfereOnce;
          this.interfereOnce = null;
          f();
        }
        if ((this.file?.sha ?? undefined) !== sha) throw new ConflictError();
        this.puts++;
        this.file = { blob: structuredClone(blob), sha: `sha${++this.n}` };
        return this.file.sha;
      },
    };
  }
}

interface Device {
  vault: Vault;
  sync: SyncManager;
  statuses: SyncStatus[];
  dataChanged: number;
}

let dir: string;
let repo: FakeRepo;
let seq = 0;

function device(): Device {
  const vault = new Vault(path.join(dir, `vault${++seq}.json`), FAST);
  const d: Device = { vault, statuses: [], dataChanged: 0, sync: null as unknown as SyncManager };
  d.sync = new SyncManager({
    vault,
    makeStore: () => repo.store(),
    onStatus: (s) => d.statuses.push(s),
    onDataChanged: () => d.dataChanged++,
  });
  return d;
}

const conn = (id: string, name = id): Connection => ({
  id,
  updatedAt: Date.now(),
  name,
  host: `${id}.example.com`,
  port: 22,
  username: 'root',
});

/** Device A with a vault and sync connected (first sync uploads). */
async function deviceA(pw = 'first-password'): Promise<Device> {
  const a = device();
  await a.vault.create(pw);
  await a.vault.update((v) => {
    v.sync = { repo: 'me/vault', token: 't' };
    v.connections.push(conn('web'));
  });
  expect((await a.sync.syncNow()).state).toBe('ok');
  return a;
}

/** Device B restored from the repo, like "Restore from GitHub" does. */
async function deviceB(pw = 'first-password'): Promise<Device> {
  const b = device();
  await b.vault.restore(repo.file!.blob, pw, (v) => (v.sync = { repo: 'me/vault', token: 't' }));
  return b;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'terminaltab-sync-'));
  repo = new FakeRepo();
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('SyncManager', () => {
  it('uploads the first time and restores on a second device', async () => {
    await deviceA();
    expect(repo.puts).toBe(1);
    const b = await deviceB();
    expect(b.vault.get().connections.map((c) => c.name)).toEqual(['web']);
    expect(b.vault.get().sync?.repo).toBe('me/vault');
  });

  it('only stores encrypted data in the repo', async () => {
    await deviceA();
    const raw = JSON.stringify(repo.file);
    expect(raw).not.toContain('web.example.com');
    expect(raw).not.toContain('"token"');
  });

  it('merges edits made on both devices', async () => {
    const a = await deviceA();
    const b = await deviceB();
    await a.vault.update((v) => v.connections.push(conn('db')));
    await b.vault.update((v) => v.connections.push(conn('mail')));
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    const names = (d: Device) => d.vault.get().connections.map((c) => c.name).sort();
    expect(names(a)).toEqual(['db', 'mail', 'web']);
    expect(names(b)).toEqual(['db', 'mail', 'web']);
    expect(a.dataChanged).toBeGreaterThan(0);
  });

  it('propagates deletions', async () => {
    const a = await deviceA();
    const b = await deviceB();
    await b.vault.update((v) => {
      v.connections = [];
      v.tombstones.push({ id: 'web', updatedAt: Date.now() + 1 });
    });
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.vault.get().connections).toEqual([]);
  });

  it('retries when another device pushes at the same moment', async () => {
    const a = await deviceA();
    const b = await deviceB();
    await b.vault.update((v) => v.connections.push(conn('from-b')));
    await a.vault.update((v) => v.connections.push(conn('from-a')));
    // B pushes in between A's download and upload.
    repo.interfereOnce = () => {
      const other = b.vault.exportBlob();
      repo.file = { blob: other, sha: 'b-sha' };
    };
    expect((await a.sync.syncNow()).state).toBe('ok');
    expect(a.vault.get().connections.map((c) => c.name).sort()).toEqual(['from-a', 'from-b', 'web']);
  });

  it('asks for the new password after it was changed on another device', async () => {
    const a = await deviceA();
    const b = await deviceB();
    await a.vault.changePassword('first-password', 'second-password-123');
    await a.vault.update((v) => v.connections.push(conn('after-change')));
    expect((await a.sync.syncNow()).state).toBe('ok');

    const s1 = await b.sync.syncNow();
    expect(s1.state).toBe('needs-password');
    // Scheduled syncs don't get past this until the user answers.
    expect((await b.sync.syncNow()).state).toBe('needs-password');
    expect((await b.sync.syncNow('wrong-password!')).state).toBe('needs-password');
    expect((await b.sync.syncNow('second-password-123')).state).toBe('ok');
    expect(b.vault.get().connections.map((c) => c.name)).toContain('after-change');

    // B now uses the new password locally too.
    const reopened = new Vault((b.vault as unknown as { filePath: string }).filePath, FAST);
    await reopened.unlock('second-password-123');
  });

  it('can still read the old remote copy right after changing the password locally', async () => {
    const a = await deviceA();
    const b = await deviceB();
    await b.vault.update((v) => v.connections.push(conn('from-b')));
    await b.sync.syncNow(); // remote: old password, includes from-b
    await a.vault.changePassword('first-password', 'second-password-123');
    expect((await a.sync.syncNow()).state).toBe('ok');
    expect(a.vault.get().connections.map((c) => c.name)).toContain('from-b');
    expect(a.vault.usesCurrentKey(repo.file!.blob)).toBe(true);
  });

  it('reports errors and is off without config', async () => {
    const d = device();
    await d.vault.create('some-password');
    expect((await d.sync.syncNow()).state).toBe('off');
    await d.vault.update((v) => (v.sync = { repo: 'me/vault', token: 't' }));
    repo.store = () => ({
      get: async () => {
        throw new Error('GitHub rejected the token (invalid or expired).');
      },
      put: async () => '',
    });
    const s = await d.sync.syncNow();
    expect(s).toMatchObject({ state: 'error', message: 'GitHub rejected the token (invalid or expired).' });
  });
});
