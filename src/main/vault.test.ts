import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptVault, encryptVault, Vault, WrongPasswordError } from './vault';
import { emptyVault } from '../shared/types';

// Cheap KDF params so tests run fast.
const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('encryptVault / decryptVault', () => {
  it('round-trips data', async () => {
    const data = emptyVault();
    data.connections.push({ id: 'c1', updatedAt: 1, name: 'web', host: 'example.com', port: 22, username: 'root' });
    const blob = await encryptVault(data, 'correct horse', FAST);
    expect(await decryptVault(blob, 'correct horse')).toEqual(data);
  });

  it('rejects a wrong password', async () => {
    const blob = await encryptVault(emptyVault(), 'correct horse', FAST);
    await expect(decryptVault(blob, 'wrong horse')).rejects.toBeInstanceOf(WrongPasswordError);
  });
});

describe('Vault', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'terminaltab-'));
    file = path.join(dir, 'vault.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('creates, persists, locks and unlocks', async () => {
    const v = new Vault(file, FAST);
    expect(await v.exists()).toBe(false);
    await v.create('master-password');
    await v.update((d) => {
      d.keys.push({ id: 'k1', updatedAt: 1, name: 'aws', pem: '-----BEGIN SECRET-----' });
    });
    v.lock();
    expect(v.isUnlocked).toBe(false);

    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('aws');
    expect(raw).not.toContain('BEGIN');

    const v2 = new Vault(file, FAST);
    await expect(v2.unlock('nope-nope')).rejects.toBeInstanceOf(WrongPasswordError);
    await v2.unlock('master-password');
    expect(v2.get().keys[0].name).toBe('aws');
  });

  it('changes the master password', async () => {
    const v = new Vault(file, FAST);
    await v.create('old-password');
    await v.changePassword('old-password', 'new-password');
    const v2 = new Vault(file, FAST);
    await expect(v2.unlock('old-password')).rejects.toBeInstanceOf(WrongPasswordError);
    await v2.unlock('new-password');
  });

  it('rejects short master passwords', async () => {
    await expect(new Vault(file, FAST).create('short')).rejects.toThrow(/at least 8/);
  });
});
