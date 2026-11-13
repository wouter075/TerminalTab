import { describe, expect, it } from 'vitest';
import { ConflictError, GitHubClient, normalizeRepo, type FetchFn } from './github';
import type { EncryptedVault } from './vault';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: FetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

const blob: EncryptedVault = {
  version: 1,
  kdf: 'scrypt',
  kdfParams: { N: 1024, r: 8, p: 1 },
  salt: 's',
  iv: 'i',
  authTag: 'a',
  ciphertext: 'c',
};

describe('normalizeRepo', () => {
  it('accepts common forms', () => {
    expect(normalizeRepo('wouter075/vault')).toBe('wouter075/vault');
    expect(normalizeRepo(' https://github.com/wouter075/vault.git ')).toBe('wouter075/vault');
    expect(normalizeRepo('github.com/wouter075/vault/')).toBe('wouter075/vault');
    expect(normalizeRepo('git@github.com:wouter075/vault.git')).toBe('wouter075/vault');
  });
  it('rejects junk', () => {
    expect(() => normalizeRepo('vault')).toThrow(/owner\/name/);
  });
});

describe('GitHubClient', () => {
  it('sends the token and refuses public repositories', async () => {
    const f = fakeFetch(() => json(200, { private: false, permissions: { push: true } }));
    await expect(new GitHubClient('tok', f.fn).checkRepo('me/vault')).rejects.toThrow(/is public/);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('refuses a read-only token', async () => {
    const f = fakeFetch(() => json(200, { private: true, permissions: { push: false } }));
    await expect(new GitHubClient('tok', f.fn).checkRepo('me/vault')).rejects.toThrow(/Read and write/);
  });

  it('explains auth errors', async () => {
    const f = fakeFetch(() => json(401, { message: 'Bad credentials' }));
    await expect(new GitHubClient('tok', f.fn).checkRepo('me/vault')).rejects.toThrow(/invalid or expired/);
  });

  it('reads, creates and updates the vault file', async () => {
    let stored: { content: string; sha: string } | null = null;
    const f = fakeFetch((_url, init) => {
      if (init.method === 'GET') return stored ? json(200, { ...stored, encoding: 'base64' }) : json(404, {});
      const body = JSON.parse(init.body as string) as { content: string; sha?: string };
      if ((stored?.sha ?? undefined) !== body.sha) return json(409, { message: 'does not match' });
      stored = { content: body.content, sha: `v${Math.random()}` };
      return json(200, { content: { sha: stored.sha } });
    });
    const store = new GitHubClient('tok', f.fn).store('me/vault');
    expect(await store.get()).toBeNull();
    const sha1 = await store.put(blob, undefined);
    const got = await store.get();
    expect(got).toEqual({ blob, sha: sha1 });
    await expect(store.put(blob, 'stale')).rejects.toBeInstanceOf(ConflictError);
    await store.put({ ...blob, iv: 'i2' }, sha1);
    expect((await store.get())!.blob.iv).toBe('i2');
    expect(f.calls.some((c) => c.url === 'https://api.github.com/repos/me/vault/contents/terminaltab-vault.json')).toBe(true);
  });
});
