import type { KnownHost, VaultData, VaultItem } from '../shared/types';

/** Union by id; when both sides have an item, the most recently updated one wins. */
function unionById<T extends VaultItem>(a: T[], b: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const cur = map.get(item.id);
    if (!cur || item.updatedAt > cur.updatedAt) map.set(item.id, item);
  }
  return [...map.values()];
}

/** One entry per host:port, the most recently trusted one. */
function latestPerHost(hosts: KnownHost[]): KnownHost[] {
  const map = new Map<string, KnownHost>();
  for (const h of hosts) {
    const cur = map.get(h.hostPort);
    if (!cur || h.updatedAt > cur.updatedAt) map.set(h.hostPort, h);
  }
  return [...map.values()];
}

/**
 * Merge two copies of the vault item by item.
 * - Items are matched by id; the newer `updatedAt` wins.
 * - A tombstone deletes an item unless the item was edited after the deletion.
 * - `settings` and `sync` are device-local and always come from `local`.
 */
export function mergeVaults(local: VaultData, remote: VaultData): VaultData {
  const tombstones = unionById(local.tombstones, remote.tombstones);
  const deletedAt = new Map(tombstones.map((t) => [t.id, t.updatedAt]));
  const alive = <T extends VaultItem>(items: T[]) =>
    items.filter((i) => !(deletedAt.has(i.id) && deletedAt.get(i.id)! >= i.updatedAt));

  const keys = alive(unionById(local.keys, remote.keys));
  const keyIds = new Set(keys.map((k) => k.id));
  const connections = alive(unionById(local.connections, remote.connections)).map((c) =>
    // A key deleted on another device: drop the dangling reference.
    c.keyId && !keyIds.has(c.keyId) ? { ...c, keyId: undefined } : c,
  );
  const knownHosts = latestPerHost(alive(unionById(local.knownHosts, remote.knownHosts)));

  return {
    ...local,
    connections,
    keys,
    knownHosts,
    tombstones,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
  };
}

/** Compare the synced parts of two vaults (ignores order, settings and sync config). */
export function sameSyncedContent(a: VaultData, b: VaultData): boolean {
  const canon = (d: VaultData) => {
    const byId = <T extends VaultItem>(xs: T[]) =>
      [...xs]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((x) => JSON.stringify(x, Object.keys(x).sort()));
    return JSON.stringify([byId(d.connections), byId(d.keys), byId(d.knownHosts), byId(d.tombstones)]);
  };
  return canon(a) === canon(b);
}
