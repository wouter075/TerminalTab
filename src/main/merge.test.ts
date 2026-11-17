import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, emptyVault, type Connection, type VaultData } from '../shared/types';
import { mergeVaults, sameSyncedContent } from './merge';

const conn = (id: string, updatedAt: number, extra: Partial<Connection> = {}): Connection => ({
  id,
  updatedAt,
  name: id,
  host: `${id}.example.com`,
  port: 22,
  username: 'root',
  ...extra,
});

const vault = (patch: Partial<VaultData>): VaultData => ({ ...emptyVault(), updatedAt: 0, ...patch });

describe('mergeVaults', () => {
  it('keeps servers added on either device', () => {
    const m = mergeVaults(vault({ connections: [conn('a', 1)] }), vault({ connections: [conn('b', 1)] }));
    expect(m.connections.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });

  it('takes the most recent edit of the same server', () => {
    const local = vault({ connections: [conn('a', 5, { name: 'local edit' })] });
    const remote = vault({ connections: [conn('a', 9, { name: 'remote edit' })] });
    expect(mergeVaults(local, remote).connections[0].name).toBe('remote edit');
    expect(mergeVaults(remote, local).connections[0].name).toBe('remote edit');
  });

  it('applies deletions from the other device', () => {
    const local = vault({ connections: [conn('a', 5), conn('b', 5)] });
    const remote = vault({ connections: [conn('b', 5)], tombstones: [{ id: 'a', updatedAt: 7 }] });
    const m = mergeVaults(local, remote);
    expect(m.connections.map((c) => c.id)).toEqual(['b']);
    expect(m.tombstones).toEqual([{ id: 'a', updatedAt: 7 }]);
  });

  it('keeps an item edited after it was deleted elsewhere', () => {
    const local = vault({ connections: [conn('a', 10)] });
    const remote = vault({ tombstones: [{ id: 'a', updatedAt: 7 }] });
    expect(mergeVaults(local, remote).connections.map((c) => c.id)).toEqual(['a']);
  });

  it('clears references to keys deleted on another device', () => {
    const local = vault({
      keys: [{ id: 'k', updatedAt: 1, name: 'k', pem: 'x' }],
      connections: [conn('a', 1, { keyId: 'k' })],
    });
    const remote = vault({ tombstones: [{ id: 'k', updatedAt: 5 }] });
    const m = mergeVaults(local, remote);
    expect(m.keys).toEqual([]);
    expect(m.connections[0].keyId).toBeUndefined();
  });

  it('keeps one trusted host key per host, the newest', () => {
    const local = vault({ knownHosts: [{ id: 'h1', updatedAt: 1, hostPort: 'x:22', fingerprint: 'old' }] });
    const remote = vault({ knownHosts: [{ id: 'h2', updatedAt: 2, hostPort: 'x:22', fingerprint: 'new' }] });
    expect(mergeVaults(local, remote).knownHosts.map((h) => h.fingerprint)).toEqual(['new']);
  });

  it('merges snippets and their deletions', () => {
    const snip = (id: string, updatedAt: number, command = id) => ({ id, updatedAt, name: id, command, run: false });
    const local = vault({ snippets: [snip('s1', 1), snip('s2', 1, 'old')] });
    const remote = vault({ snippets: [snip('s2', 5, 'new'), snip('s3', 1)], tombstones: [{ id: 's1', updatedAt: 2 }] });
    const m = mergeVaults(local, remote);
    expect(m.snippets.map((s) => `${s.id}:${s.command}`).sort()).toEqual(['s2:new', 's3:s3']);
    expect(sameSyncedContent(m, local)).toBe(false);
  });

  it('accepts a remote copy from an older version without snippets', () => {
    const old = { ...vault({ connections: [conn('a', 1)] }) } as Partial<VaultData>;
    delete old.snippets;
    const m = mergeVaults(vault({ snippets: [{ id: 's', updatedAt: 1, name: 's', command: 'ls', run: true }] }), old as VaultData);
    expect(m.snippets).toHaveLength(1);
  });

  it('never takes settings or sync config from the remote copy', () => {
    const local = vault({ sync: { repo: 'me/local', token: 't1' } });
    const remote = vault({ sync: { repo: 'me/remote', token: 't2' }, settings: { ...DEFAULT_SETTINGS, fontSize: 30, theme: 'nord' } });
    const m = mergeVaults(local, remote);
    expect(m.sync?.repo).toBe('me/local');
    expect(m.settings).toEqual(local.settings);
  });
});

describe('sameSyncedContent', () => {
  it('ignores order and device-local fields', () => {
    const a = vault({ connections: [conn('a', 1), conn('b', 1)], sync: { repo: 'x/y', token: 't' } });
    const b = vault({ connections: [conn('b', 1), conn('a', 1)] });
    expect(sameSyncedContent(a, b)).toBe(true);
    expect(sameSyncedContent(a, vault({ connections: [conn('a', 1)] }))).toBe(false);
  });
});
